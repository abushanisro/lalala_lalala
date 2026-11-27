'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertTriangle, ArrowUp, Box, CheckCircle2, ChevronDown, FileText, Image as ImageIcon, Loader2, Mic, Plus, Upload, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { drawingReadingsApi, type DrawingReading } from '@/lib/api/drawing-readings';
import { useFactories } from '@/lib/api/hooks/useFx';
import { useProcessCalculatorMappings } from '@/lib/api/hooks/useProcessCalculatorMappings';
import { useRawMaterials } from '@/lib/api/hooks/useRawMaterials';
import { PROCESS_MATERIALS, materialPickerQuery } from '@/lib/features/material-picker-query';
import { processGroupOptionsFrom } from '@/lib/features/process-group';
import { intakeApi } from '@/lib/intake/api';
import { dictationProblem, transcriptOf, withDictation, type HeardResults } from '@/lib/intake/dictation';
import { pastedNames, pasteIsOfFiles } from '@/lib/intake/paste';
import { FIRST_HELD_TICK, placeholderAt, STILL_PLACEHOLDER, TYPING } from '@/lib/intake/placeholder';
import {
  carriesFiles, costable, gradeFor, INTAKE_ACCEPT, intakeFileKind, planBlockers, planPart, shapeSummary, type IntakePlan, type PlanPart,
} from '@/lib/intake/plan';
import { runIntake, type IntakeEvent, type IntakeResult } from '@/lib/intake/run';

type Phase = 'compose' | 'reading' | 'plan' | 'creating' | 'done';
/** What became of one dropped drawing: being read, read, not a drawing of a part, or not readable (with the server's reason). */
type Read = { state: 'reading' } | { state: 'read'; reading: DrawingReading } | { state: 'failed'; why: string };

const SELECT = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-60';
const LOCATION_KEY = 'intake.location';
const LOCATION_EVENT = 'intake-location';
const remembered = (): string => { try { return localStorage.getItem(LOCATION_KEY) ?? ''; } catch { return ''; } };
/** Where the parts are made, as chosen in this session; until then, what the browser remembers from the last one. */
let chosenLocation: string | null = null;
const madeInNow = (): string => chosenLocation ?? remembered();
/** Chooses where the parts are made, for the prompt's menu and the plan alike, and remembers it for next time. */
function chooseMadeIn(location: string) {
  chosenLocation = location;
  try { localStorage.setItem(LOCATION_KEY, location); } catch { /* the choice is simply not remembered */ }
  window.dispatchEvent(new Event(LOCATION_EVENT));
}
function onMadeInChange(notify: () => void) {
  window.addEventListener(LOCATION_EVENT, notify);
  window.addEventListener('storage', notify);
  return () => { window.removeEventListener(LOCATION_EVENT, notify); window.removeEventListener('storage', notify); };
}
const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'The server did not answer.');
const wholeNumber = (text: string): number | null => { const n = Number(text.replace(/,/g, '')); return text.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null; };

/**
 * The dashboard's intake: drop drawings, pictures of parts, STEP files or a zip, and say what the job is. Each drawing is read by the
 * vision model; the box then shows the plan (project, BOM, each part with its material, size and process) to check and correct, and
 * one click creates it all, builds a model from each drawing and costs it with the existing engines.
 */
export function IntakeBox({ title = 'What do you want to cost?' }: { title?: ReactNode }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('compose');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [reads, setReads] = useState<Record<string, Read>>({});
  const [plan, setPlan] = useState<IntakePlan | null>(null);
  const [events, setEvents] = useState<IntakeEvent[]>([]);
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useTypedPlaceholder(textarea, phase === 'compose' && note === '');

  const { data: factories } = useFactories();
  // Known only in the browser (its storage): the server renders the menu with no choice, and the page shows the remembered one.
  const madeIn = useSyncExternalStore(onMadeInChange, madeInNow, () => '');
  const { data: catalog } = useProcessCalculatorMappings({ limit: 1000 });
  const groups = useMemo(() => processGroupOptionsFrom(catalog?.mappings), [catalog]);

  // The box grows with what is typed, up to a few lines.
  useEffect(() => {
    const box = textarea.current;
    if (!box) return;
    box.style.height = '56px';
    box.style.height = `${Math.min(Math.max(box.scrollHeight, 56), 180)}px`;
  }, [note]);

  const add = useCallback((dropped: FileList | File[]) => {
    const all = Array.from(dropped);
    const taken = all.filter(file => intakeFileKind(file.name) !== null);
    setFiles(current => [...current, ...taken.filter(file => !current.some(have => have.name === file.name))]);
    setRefused(all.filter(file => intakeFileKind(file.name) === null).map(file => file.name));
  }, []);

  const dragging = useFileDrop(phase === 'compose', add);
  // A copied picture is "image.png" every time: pasted files are named apart from the ones already there before they are added.
  usePastedFiles(phase === 'compose', useCallback((pasted: File[]) => {
    const names = pastedNames(pasted, files.map(file => file.name));
    add(pasted.map((file, i) => { const name = names[i] ?? file.name; return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified }); }));
  }, [add, files]));
  const saidBefore = useRef('');
  const dictation = useDictation(useCallback((heard: string) => { setNote(withDictation(saidBefore.current, heard)); }, []));
  const stopDictation = dictation.stop;
  useEffect(() => { if (phase !== 'compose') stopDictation(); }, [phase, stopDictation]);

  const read = async () => {
    const drawings = files.filter(file => intakeFileKind(file.name) === 'drawing');
    setPhase('reading');
    setRefused([]);
    setReads(Object.fromEntries(drawings.map(file => [file.name, { state: 'reading' }])));
    const done: Record<string, Read> = {};
    for (const file of drawings) {                    // one at a time: a person may run only a few AI requests at once
      try {
        done[file.name] = { state: 'read', reading: (await drawingReadingsApi.read(file, note)).reading };
      } catch (error) {
        done[file.name] = { state: 'failed', why: messageOf(error) };
      }
      setReads(current => ({ ...current, [file.name]: done[file.name] ?? { state: 'reading' } }));
    }
    const parts = drawings.flatMap(file => { const r = done[file.name]; return r?.state === 'read' ? planPart(file.name, r.reading, groups) ?? [] : []; });
    const firstLine = note.trim().split('\n')[0] ?? '';
    setPlan({
      projectName: firstLine.length > 0 && firstLine.length <= 60 ? firstLine : parts[0]?.name ?? files[0]?.name.replace(/\.[^.]+$/, '') ?? '',
      bomName: parts.length > 0 ? 'Parts from drawings' : 'Imported parts',
      location: madeInNow(), annualVolume: null, batchSize: null, parts,
      cadFiles: files.filter(file => intakeFileKind(file.name) === 'cad').map(file => file.name),
    });
    setPhase('plan');
  };

  const create = async () => {
    if (!plan) return;
    if (plan.location) chooseMadeIn(plan.location);
    setPhase('creating');
    setEvents([]);
    setFatal(null);
    try {
      const made = await runIntake(plan, new Map(files.map(file => [file.name, file])), intakeApi,
        event => { setEvents(current => [...current.filter(e => e.key !== event.key), event]); });
      setResult(made);
    } catch (error) {
      setFatal(messageOf(error));
    }
    setPhase('done');
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['cost-analytics'] });
  };

  const reset = () => { setPhase('compose'); setNote(''); setFiles([]); setRefused([]); setReads({}); setPlan(null); setEvents([]); setResult(null); setFatal(null); };
  const setPart = (file: string, change: Partial<PlanPart>) => { setPlan(current => current && { ...current, parts: current.parts.map(p => (p.file === file ? { ...p, ...change } : p)) }); };
  const blockers = plan ? planBlockers(plan) : [];
  const skipped = Object.entries(reads).flatMap(([name, r]) => (r.state === 'failed' ? [{ name, why: r.why }] : r.state === 'read' && !r.reading.isDrawing ? [{ name, why: 'Not a drawing or a picture of a part.' }] : []));

  return (
    <section aria-label="Start from a drawing" className="space-y-6">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:text-5xl">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">Drop a drawing, a picture of a part, STEP files or a zip. The project, the BOM and the parts are made for you.</p>
        </div>
        <div className={`relative rounded-3xl border bg-card shadow-lg transition-colors ${dragging ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}>
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-0.5 rounded-3xl border-2 border-dashed border-primary bg-card/95 text-center">
              <Upload className="h-5 w-5 text-primary" />
              <p className="text-sm font-semibold text-foreground">Drop to add</p>
              <p className="text-xs text-muted-foreground">Drawings, pictures, STEP files or a zip</p>
            </div>
          )}
          <Textarea
            ref={textarea} value={note} disabled={phase !== 'compose'} onChange={event => { setNote(event.target.value); }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && files.length > 0 && phase === 'compose') { event.preventDefault(); void read(); } }}
            placeholder={STILL_PLACEHOLDER}
            aria-label="What the job is"
            className="min-h-[56px] resize-none border-none bg-transparent px-5 pb-2 pt-4 text-base shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-2 px-4 pb-1" aria-label="Files added">
              {files.map(file => (
                <li key={file.name} className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">
                  {intakeFileKind(file.name) === 'cad' ? <Box className="h-3.5 w-3.5 shrink-0" /> : file.name.toLowerCase().endsWith('.pdf') ? <FileText className="h-3.5 w-3.5 shrink-0" /> : <ImageIcon className="h-3.5 w-3.5 shrink-0" />}
                  <span className="break-all">{file.name}</span>
                  {phase === 'compose' && (
                    <button type="button" aria-label={`Remove ${file.name}`} className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                      onClick={() => { setFiles(current => current.filter(f => f.name !== file.name)); }}>
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-2 p-3">
            <input ref={picker} type="file" multiple accept={INTAKE_ACCEPT} className="hidden"
              onChange={event => { if (event.target.files) add(event.target.files); event.target.value = ''; }} />
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="icon" aria-label="Add files" title="Add drawings, pictures, STEP files or a zip" disabled={phase !== 'compose'}
                className="h-9 w-9 rounded-full text-muted-foreground" onClick={() => picker.current?.click()}>
                <Plus className="h-5 w-5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" disabled={phase !== 'compose' || !factories?.length}
                    aria-label={madeIn ? `Where the parts are made: ${madeIn}` : 'Where the parts are made'} title="Where the parts are made"
                    className="h-9 shrink-0 gap-1 rounded-full px-3 text-sm font-medium text-foreground">
                    {madeIn || 'Made in'}
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                  <DropdownMenuLabel>Where the parts are made</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={madeIn} onValueChange={chooseMadeIn}>
                    {(factories ?? []).map(f => <DropdownMenuRadioItem key={f.location} value={f.location}>{f.location} ({f.code})</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {phase === 'compose' && <p className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">Drag files onto this page, paste a picture, or add them with +</p>}
            <div className="flex shrink-0 items-center gap-1">
              {dictation.available && (
                <Button type="button" variant={dictation.listening ? 'default' : 'ghost'} size="icon" aria-pressed={dictation.listening} disabled={phase !== 'compose'}
                  aria-label={dictation.listening ? 'Stop dictating' : 'Dictate'}
                  title={dictation.listening ? 'Listening. Press to stop.' : "Dictate what the job is (the browser's speech recognition)"}
                  className={`h-9 w-9 shrink-0 rounded-full ${dictation.listening ? 'animate-pulse' : 'text-muted-foreground'}`}
                  onClick={() => { if (dictation.listening) dictation.stop(); else { saidBefore.current = note; dictation.start(); } }}>
                  <Mic className="h-4 w-4" />
                </Button>
              )}
              <Button type="button" size="icon" aria-label="Read the files" title={files.length === 0 ? 'Add a file first' : 'Read the files'}
                disabled={phase !== 'compose' || files.length === 0} onClick={() => { void read(); }} className="h-9 w-9 rounded-full">
                {phase === 'reading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
        {phase === 'compose' && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-full" onClick={() => picker.current?.click()}><ImageIcon className="h-4 w-4" /> Drawing or picture</Button>
            <Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-full" onClick={() => picker.current?.click()}><Upload className="h-4 w-4" /> STEP files or a zip</Button>
          </div>
        )}
        {refused.length > 0 && (
          <p className="text-center text-xs text-destructive" role="alert">
            Not taken: {refused.join(', ')}. The box takes PNG, JPEG, WebP, GIF and PDF drawings, STEP files and zips.
          </p>
        )}
        {dictation.problem && <p className="text-center text-xs text-destructive" role="alert">{dictation.problem}</p>}
      </div>

      {phase === 'reading' && (
        <Card className="mx-auto max-w-3xl rounded-xl shadow-sm">
          <CardContent className="space-y-2 p-5">
            {Object.entries(reads).map(([name, r]) => (
              <Line key={name} state={r.state === 'reading' ? 'running' : r.state === 'failed' ? 'failed' : 'done'} title={name}
                detail={r.state === 'reading' ? 'Reading the drawing (about a quarter of a minute)' : r.state === 'failed' ? r.why : 'Read'} />
            ))}
            {Object.keys(reads).length === 0 && <Line state="running" title="Preparing the plan" detail="No drawing to read: the CAD files are imported as they are." />}
          </CardContent>
        </Card>
      )}

      {phase === 'plan' && plan && (
        <Card className="rounded-xl shadow-sm">
          <CardHeader className="border-b border-border p-6 pb-4">
            <CardTitle className="text-lg font-semibold">Check the plan</CardTitle>
            <p className="text-sm text-muted-foreground">This is what was read. Correct anything that is wrong; nothing is created until you click Create.</p>
          </CardHeader>
          <CardContent className="space-y-6 p-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
              <Field label="Project" className="xl:col-span-2"><Input value={plan.projectName} onChange={event => { setPlan({ ...plan, projectName: event.target.value }); }} /></Field>
              <Field label="BOM"><Input value={plan.bomName} onChange={event => { setPlan({ ...plan, bomName: event.target.value }); }} /></Field>
              <Field label="Made in">
                <select aria-label="Made in" className={SELECT} value={plan.location} onChange={event => { setPlan({ ...plan, location: event.target.value }); }}>
                  <option value="">Choose a location</option>
                  {(factories ?? []).map(f => <option key={f.location} value={f.location}>{f.location} ({f.code})</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Annual volume"><Input inputMode="numeric" placeholder="Not stated" defaultValue="" onChange={event => { setPlan({ ...plan, annualVolume: wholeNumber(event.target.value) }); }} /></Field>
                <Field label="Batch size"><Input inputMode="numeric" placeholder="Engine's own" defaultValue="" onChange={event => { setPlan({ ...plan, batchSize: wholeNumber(event.target.value) }); }} /></Field>
              </div>
            </div>

            {plan.parts.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {plan.parts.map(part => <PartRow key={part.file} part={part} groups={groups} onChange={change => { setPart(part.file, change); }} />)}
              </ul>
            )}
            {plan.cadFiles.length > 0 && (
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Imported as they are:</span> {plan.cadFiles.join(', ')}. Their parts appear in the BOM when the import finishes.</p>
            )}
            {skipped.length > 0 && (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {skipped.map(s => <li key={s.name}><span className="font-medium text-foreground">{s.name}</span> is left out. {s.why}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button onClick={() => { void create(); }} disabled={blockers.length > 0}>Create project</Button>
              <Button variant="outline" onClick={reset}>Start over</Button>
              {blockers.length > 0 && <p className="text-sm text-muted-foreground" role="status">{blockers[0]}</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {(phase === 'creating' || phase === 'done') && (
        <Card className="mx-auto max-w-3xl rounded-xl shadow-sm">
          <CardContent className="space-y-2 p-5">
            {events.map(event => <Line key={event.key} state={event.state} title={event.title} detail={event.detail} />)}
            {fatal && <p className="pt-1 text-sm text-destructive" role="alert">Stopped: {fatal}</p>}
            {phase === 'done' && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                {result && <Button asChild><Link href={`/projects/${result.projectId}/bom/${result.bomId}`}>Open the BOM</Link></Button>}
                <Button variant="outline" onClick={reset}>Start another</Button>
                {result && <p className="text-sm text-muted-foreground">{result.parts.filter(p => p.costed).length} of {result.parts.length} parts costed.</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/**
 * Files pasted anywhere on the page are the prompt's while it is taking files: a copied picture, or a file copied in a file manager. A
 * paste that is text (also text that comes with a picture of itself, as a copied table cell does) is left to the field it is pasted into.
 */
function usePastedFiles(taking: boolean, onFiles: (files: File[]) => void) {
  useEffect(() => {
    if (!taking) return;
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!pasteIsOfFiles(files.map(file => file.name), event.clipboardData?.getData('text/plain') ?? '')) return;
      event.preventDefault();
      onFiles(files);
    };
    window.addEventListener('paste', paste);
    return () => { window.removeEventListener('paste', paste); };
  }, [taking, onFiles]);
}

/** The browser's speech recognition, as far as dictation uses it (it is not in TypeScript's DOM types, and Chrome and Safari prefix it). */
interface Recognizer {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: HeardResults }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
}
type RecognizerClass = new () => Recognizer;
function recognizerClass(): RecognizerClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
const never = () => () => undefined;

/**
 * Dictation into the prompt with the browser's own speech recognition, where it has one (`available`; the browser decides where the
 * audio is recognised). While it listens, everything heard so far is handed to `onHeard` each time it firms up. It stops on `stop`, when
 * the browser ends it, or on a failure, which `problem` says in plain words.
 */
function useDictation(onHeard: (heard: string) => void) {
  // Known only in the browser: the server renders the prompt without the microphone, and the page adds it once it runs.
  const available = useSyncExternalStore(never, () => recognizerClass() !== null, () => false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recognizer = useRef<Recognizer | null>(null);
  useEffect(() => () => { recognizer.current?.abort(); }, []);
  const stop = useCallback(() => { recognizer.current?.stop(); }, []);
  const start = useCallback(() => {
    const Recognition = recognizerClass();
    if (!Recognition || recognizer.current) return;
    const r = new Recognition();
    r.lang = navigator.language;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => { onHeard(transcriptOf(event.results)); };
    r.onerror = (event) => { setProblem(dictationProblem(event.error)); };
    r.onend = () => { recognizer.current = null; setListening(false); };
    recognizer.current = r;
    setProblem(null);
    setListening(true);
    try { r.start(); } catch { recognizer.current = null; setListening(false); setProblem(dictationProblem('audio-capture')); }
  }, [onHeard]);
  return { available, listening, problem, start, stop };
}

/**
 * Files dragged anywhere over the page are the prompt's: true while a drag that carries files is over the window, and the dropped files
 * are handed to `onFiles`. A drop of files is never left to the browser, which would open the file and lose the page; while the prompt
 * is not taking files (they are being read, the plan is open) the drop is refused. A drag that carries no files (text, a link) is left
 * alone.
 */
function useFileDrop(taking: boolean, onFiles: (files: File[]) => void): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    // dragenter and dragleave fire for every element the pointer crosses: only leaving the last one ends the drag.
    let depth = 0;
    const withFiles = (event: DragEvent) => carriesFiles(event.dataTransfer?.types);
    const enter = (event: DragEvent) => { if (!withFiles(event)) return; depth += 1; setOver(true); };
    const move = (event: DragEvent) => {
      if (!withFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = taking ? 'copy' : 'none';
    };
    const leave = (event: DragEvent) => { if (!withFiles(event)) return; depth = Math.max(0, depth - 1); if (depth === 0) setOver(false); };
    const drop = (event: DragEvent) => {
      if (!withFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      if (taking && event.dataTransfer) onFiles(Array.from(event.dataTransfer.files));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', move);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', move);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [taking, onFiles]);
  return over && taking;
}

/**
 * Types the prompt's examples into its placeholder, one after another, while the prompt is empty and waiting (`typing`). The field is
 * written to directly, so nothing re-renders on a tick. Nothing moves for a reader who asked for less motion, or while the page is
 * hidden; when the typing stops the placeholder is the first example again.
 */
function useTypedPlaceholder(field: RefObject<HTMLTextAreaElement | null>, typing: boolean) {
  useEffect(() => {
    const node = field.current;
    if (!node || !typing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let tick = FIRST_HELD_TICK;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      tick += 1;
      node.placeholder = placeholderAt(tick);
    }, TYPING.tickMs);
    return () => { window.clearInterval(timer); node.placeholder = STILL_PLACEHOLDER; };
  }, [field, typing]);
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`block space-y-1.5 text-sm ${className ?? ''}`}><span className="font-medium text-foreground">{label}</span>{children}</label>;
}

function Line({ state, title, detail }: { state: 'running' | 'done' | 'failed'; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      {state === 'running' ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        : state === 'done' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
      <p className="min-w-0"><span className="break-words font-medium text-foreground">{title}</span><span className="block text-muted-foreground">{detail}</span></p>
    </div>
  );
}

/** One part of the plan: what was read, and the two choices a cost needs (the process and the material grade). */
function PartRow({ part, groups, onChange }: { part: PlanPart; groups: string[]; onChange: (change: Partial<PlanPart>) => void }) {
  const { data: materials, isLoading } = useRawMaterials(
    materialPickerQuery({ processGroup: part.processGroup, group: PROCESS_MATERIALS }), { enabled: !!part.processGroup });
  const grades = useMemo(() => [...new Set((materials?.items ?? []).map(m => m.material))].sort((a, b) => a.localeCompare(b)), [materials]);
  // The grade the drawing's material names, once the grades of the chosen process are in: offered, not imposed.
  const matched = useRef<string | null>(null);
  useEffect(() => {
    if (!part.processGroup || grades.length === 0 || matched.current === part.processGroup) return;
    matched.current = part.processGroup;
    if (!part.grade || !grades.includes(part.grade)) onChange({ grade: gradeFor(part.materialRead, grades) });
  }, [grades, part.processGroup, part.grade, part.materialRead, onChange]);
  const cost = costable(part);

  return (
    <li className="space-y-3 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Part name"><Input value={part.name} onChange={event => { onChange({ name: event.target.value }); }} /></Field>
        <Field label="Part number"><Input value={part.partNumber} onChange={event => { onChange({ partNumber: event.target.value }); }} /></Field>
        <Field label="Process">
          <select aria-label="Process" className={SELECT} value={part.processGroup ?? ''} onChange={event => { onChange({ processGroup: event.target.value || null, grade: null }); }}>
            <option value="">Choose the process</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Material grade">
          <select aria-label="Material grade" className={SELECT} value={part.grade ?? ''} disabled={!part.processGroup || isLoading} onChange={event => { onChange({ grade: event.target.value || null }); }}>
            <option value="">{!part.processGroup ? 'Choose the process first' : isLoading ? 'Loading grades' : 'Choose the grade'}</option>
            {grades.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </Field>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
        <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">From</dt><dd className="break-all text-foreground">{part.file}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">Model</dt><dd className="text-foreground">{shapeSummary(part.shape, part.holes)}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">Material on the drawing</dt><dd className="text-foreground">{part.materialRead ?? 'Not stated'}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">Quantity</dt><dd className="tabular-nums text-foreground">{part.quantity}</dd></div>
        {part.processReason && <div className="flex gap-2 md:col-span-2"><dt className="shrink-0 text-muted-foreground">Why this process</dt><dd className="text-foreground">{part.processReason}</dd></div>}
      </dl>
      {part.unsure.length > 0 && (
        <details className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-foreground">{part.unsure.length} {part.unsure.length === 1 ? 'thing' : 'things'} the reader was not sure of</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{part.unsure.map(u => <li key={u}>{u}</li>)}</ul>
        </details>
      )}
      <p className={`text-sm ${cost.ok ? 'text-success' : 'text-muted-foreground'}`}>
        {cost.ok ? 'Will be costed from a model built from the drawing (approximate).' : cost.why}
      </p>
    </li>
  );
}
