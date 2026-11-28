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
import { rawMaterialsListQuery, useRawMaterials } from '@/lib/api/hooks/useRawMaterials';
import { PROCESS_MATERIALS, materialPickerQuery } from '@/lib/features/material-picker-query';
import { processGroupOptionsFrom } from '@/lib/features/process-group';
import { useDictation } from '@/lib/hooks/useDictation';
import { intakeApi } from '@/lib/intake/api';
import { answerQuestion, askQuestion, startBuild, type BuildDeps } from '@/lib/intake/build';
import type { Answer, Entry } from '@/lib/intake/conversation';
import { withDictation } from '@/lib/intake/dictation';
import { intakeDraft } from '@/lib/intake/draft';
import { ASK_PLACEHOLDER, DEFAULT_INTAKE_MODE, INTAKE_BOX, INTAKE_MODES, INTAKE_SEND, intakeModeFrom, intakeModeOf } from '@/lib/intake/modes';
import { pastedNames, pasteIsOfFiles } from '@/lib/intake/paste';
import { FIRST_HELD_TICK, placeholderAt, STILL_PLACEHOLDER, TYPING } from '@/lib/intake/placeholder';
import {
  carriesFiles, costable, gradeFor, INTAKE_ACCEPT, intakeFileKind, isPicture, planBlockers, planPart, shapeSummary, type IntakePlan, type PlanPart,
} from '@/lib/intake/plan';
import { runIntake, type IntakeEvent, type IntakeResult } from '@/lib/intake/run';

type Phase = 'compose' | 'reading' | 'plan' | 'creating' | 'done';
/** What became of one dropped drawing: being read, read, not a drawing of a part, or not readable (with the server's reason). */
type Read = { state: 'reading' } | { state: 'read'; reading: DrawingReading } | { state: 'failed'; why: string };

const SELECT = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-60';
/**
 * A choice of the prompt's that is kept: as chosen in this session, and until then what the browser remembers from the last one.
 * Everything on the page that shows it follows a change (`subscribe`), and it is remembered for next time.
 */
function rememberedChoice(key: string) {
  const changed = `intake-choice:${key}`;
  let chosen: string | null = null;
  const remembered = (): string => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
  return {
    now: (): string => chosen ?? remembered(),
    choose: (value: string) => {
      chosen = value;
      try { localStorage.setItem(key, value); } catch { /* the choice is simply not remembered */ }
      window.dispatchEvent(new Event(changed));
    },
    subscribe: (notify: () => void) => {
      window.addEventListener(changed, notify);
      window.addEventListener('storage', notify);
      return () => { window.removeEventListener(changed, notify); window.removeEventListener('storage', notify); };
    },
  };
}
/** Where the parts are made, for the prompt's menu and the plan alike. */
const madeInChoice = rememberedChoice('intake.location');
/** What the prompt does with what it is given: build, plan or ask. */
const modeChoice = rememberedChoice('intake.mode');
const modeNow = () => intakeModeFrom(modeChoice.now());
// The draft's setters are the store's own, so what is typed and added outlives the page (lib/intake/draft.ts).
const { setNote, setFiles } = intakeDraft;
const ANSWER_PLACEHOLDER = 'Type your answer, or choose above';
const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'The server did not answer.');
const wholeNumber = (text: string): number | null => { const n = Number(text.replace(/,/g, '')); return text.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null; };

/**
 * The dashboard's intake: drop drawings, pictures of parts, STEP files or a zip, and say what the job is. Each drawing is read by the
 * vision model; the box then shows the plan (project, BOM, each part with its material, size and process) to check and correct, and
 * one click creates it all, builds a model from each drawing and costs it with the existing engines. The mode menu changes what the
 * prompt does: Plan is the above. Build is a conversation (lib/intake/build.ts): it says what it read, asks for what a cost still
 * needs one question at a time, then creates and costs. Ask answers a question and creates nothing.
 */
export function IntakeBox({ title = 'What do you want to cost?' }: { title?: ReactNode }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('compose');
  // Kept outside the page: still there after a visit elsewhere in the app. The server and the first paint show an empty prompt.
  const { note, files, thread, working } = useSyncExternalStore(intakeDraft.subscribe, intakeDraft.get, () => intakeDraft.empty);
  /** The prompt takes input: nothing of the plan is open and the conversation is not busy. */
  const idle = phase === 'compose' && !working;
  /** The question the build is waiting on, if any. */
  const open = thread.find((e): e is Extract<Entry, { kind: 'question' }> => e.kind === 'question' && e.answer === null);
  const [typedWhy, setTypedWhy] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const [reads, setReads] = useState<Record<string, Read>>({});
  const [plan, setPlan] = useState<IntakePlan | null>(null);
  const [events, setEvents] = useState<IntakeEvent[]>([]);
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const { data: factories } = useFactories();
  // Known only in the browser (its storage): the server renders the menus with no choice, and the page shows the remembered ones.
  const madeIn = useSyncExternalStore(madeInChoice.subscribe, madeInChoice.now, () => '');
  const mode = useSyncExternalStore(modeChoice.subscribe, modeNow, () => DEFAULT_INTAKE_MODE);
  const stillPlaceholder = mode === 'ask' ? ASK_PLACEHOLDER : open && mode === 'build' ? ANSWER_PLACEHOLDER : STILL_PLACEHOLDER;
  useTypedPlaceholder(textarea, idle && note === '' && mode !== 'ask' && thread.length === 0, stillPlaceholder);
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

  const dragging = useFileDrop(idle, add);
  // A copied picture is "image.png" every time: pasted files are named apart from the ones already there before they are added.
  usePastedFiles(idle, useCallback((pasted: File[]) => {
    const names = pastedNames(pasted, files.map(file => file.name));
    add(pasted.map((file, i) => { const name = names[i] ?? file.name; return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified }); }));
  }, [add, files]));
  const saidBefore = useRef('');
  const dictation = useDictation(useCallback((heard: string) => { setNote(withDictation(saidBefore.current, heard)); }, []));
  const stopDictation = dictation.stop;
  useEffect(() => { if (!idle) stopDictation(); }, [idle, stopDictation]);

  // The conversation keeps to the page's foot as it grows, where the prompt is.
  const foot = useRef<HTMLDivElement>(null);
  useEffect(() => { if (thread.length > 0) foot.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [thread]);

  /** What a build calls: the page's own catalogs and the app's existing endpoints. */
  const buildDeps = (): BuildDeps => ({
    read: async (file, said) => (await drawingReadingsApi.read(file, said)).reading,
    groups,
    locations: (factories ?? []).map(f => f.location),
    grades: async processGroup => {
      const list = await queryClient.query(rawMaterialsListQuery(materialPickerQuery({ processGroup, group: PROCESS_MATERIALS })));
      return [...new Set(list.items.map(m => m.material))].sort((a, b) => a.localeCompare(b));
    },
    madeIn: madeInChoice.now(),
    create: async (made, byName, onEvent) => {
      if (made.location) madeInChoice.choose(made.location);
      try {
        return await runIntake(made, byName, intakeApi, onEvent);
      } finally {
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        void queryClient.invalidateQueries({ queryKey: ['cost-analytics'] });
      }
    },
  });
  const answer = (id: number, given: Answer) => answerQuestion(id, given, buildDeps());

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
      location: madeInChoice.now(), annualVolume: null, batchSize: null, parts,
      cadFiles: files.filter(file => intakeFileKind(file.name) === 'cad').map(file => file.name),
    });
    setPhase('plan');
  };

  const create = async () => {
    if (!plan) return;
    if (plan.location) madeInChoice.choose(plan.location);
    setPhase('creating');
    setEvents([]);
    setFatal(null);
    try {
      const made = await runIntake(plan, new Map(files.map(file => [file.name, file])), intakeApi,
        event => { setEvents(current => [...current.filter(e => e.key !== event.key), event]); });
      setResult(made);
      intakeDraft.clearInputs();                      // used: coming back to this page must not offer the same files again
    } catch (error) {
      setFatal(messageOf(error));
    }
    setPhase('done');
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['cost-analytics'] });
  };

  /** What the send button does: in Build, start the conversation or answer its open question; in Ask, ask; in Plan, read for the plan. */
  const send = () => {
    dictation.cancel();                               // the box is emptied now: what is still being heard must not fill it again
    setRefused([]);
    setTypedWhy(null);
    if (mode === 'ask') {
      void askQuestion(note.trim(), files.find(file => intakeFileKind(file.name) === 'drawing'), async (question, drawing) => (await drawingReadingsApi.ask(question, drawing)).answer);
    } else if (mode === 'plan') {
      void read();
    } else if (open) {
      void answer(open.id, { action: 'accept', value: note }).then(why => { if (why) setTypedWhy(why); else setNote(''); });
    } else {
      void startBuild(note, files, buildDeps());
    }
  };
  const canSend = idle && (mode === 'ask' ? note.trim() !== ''
    : open ? mode === 'build' && note.trim() !== '' && files.length === 0   // a question is open: the box answers it, and nothing else starts
      : files.length > 0);
  const sendTitle = !idle ? INTAKE_SEND[mode] : mode === 'ask' ? (canSend ? 'Ask' : 'Type a question first')
    : open ? (mode === 'build' ? 'Answer the question' : 'Answer the question above first, or skip it')
      : canSend ? INTAKE_SEND[mode] : 'Add a file first';

  const reset = () => { setPhase('compose'); intakeDraft.clear(); setRefused([]); setTypedWhy(null); setReads({}); setPlan(null); setEvents([]); setResult(null); setFatal(null); };
  const setPart = (file: string, change: Partial<PlanPart>) => { setPlan(current => current && { ...current, parts: current.parts.map(p => (p.file === file ? { ...p, ...change } : p)) }); };
  const blockers = plan ? planBlockers(plan) : [];
  const skipped = Object.entries(reads).flatMap(([name, r]) => (r.state === 'failed' ? [{ name, why: r.why }] : r.state === 'read' && !r.reading.isDrawing ? [{ name, why: 'Not a drawing or a picture of a part.' }] : []));

  return (
    <section aria-label="Start from a drawing" className="space-y-6">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {thread.length === 0 ? (
          <div className="text-center">
            <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:text-5xl">{title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">Drop a drawing, a picture of a part, STEP files or a zip. The project, the BOM and the parts are made for you.</p>
          </div>
        ) : <Conversation thread={thread} working={working} onAnswer={answer} onClear={reset} />}
        <div className={`relative rounded-3xl border bg-card shadow-lg transition-colors ${dragging ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}>
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-0.5 rounded-3xl border-2 border-dashed border-primary bg-card/95 text-center">
              <Upload className="h-5 w-5 text-primary" />
              <p className="text-sm font-semibold text-foreground">Drop to add</p>
              <p className="text-xs text-muted-foreground">Drawings, pictures, STEP files or a zip</p>
            </div>
          )}
          <Textarea
            ref={textarea} value={note} disabled={!idle} onChange={event => { setNote(event.target.value); }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && canSend) { event.preventDefault(); send(); } }}
            placeholder={stillPlaceholder}
            aria-label={INTAKE_BOX[mode]}
            className="min-h-[56px] resize-none border-none bg-transparent px-5 pb-2 pt-4 text-base shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {files.length > 0 && (
            <ul className="flex flex-wrap items-end gap-2 px-4 pb-1" aria-label="Files added">
              {files.map(file => {
                const remove = idle ? () => { setFiles(current => current.filter(f => f.name !== file.name)); } : null;
                // A picture is shown as the picture; a PDF or a CAD file, which the page cannot draw, by its name.
                return isPicture(file.name) ? <PictureTile key={file.name} file={file} onRemove={remove} /> : (
                  <li key={file.name} className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">
                    {intakeFileKind(file.name) === 'cad' ? <Box className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
                    <span className="break-all">{file.name}</span>
                    {remove && (
                      <button type="button" aria-label={`Remove ${file.name}`} className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={remove}>
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-center justify-between gap-2 p-3">
            <input ref={picker} type="file" multiple accept={INTAKE_ACCEPT} className="hidden"
              onChange={event => { if (event.target.files) add(event.target.files); event.target.value = ''; }} />
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="icon" aria-label="Add files" title="Add drawings, pictures, STEP files or a zip" disabled={!idle}
                className="h-9 w-9 rounded-full text-muted-foreground" onClick={() => picker.current?.click()}>
                <Plus className="h-5 w-5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" disabled={!idle}
                    aria-label={`Mode: ${intakeModeOf(mode).label}`} title="What the prompt does with this"
                    className="h-9 shrink-0 gap-1 rounded-full px-3 text-sm font-medium text-foreground">
                    {intakeModeOf(mode).label}
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  <DropdownMenuRadioGroup value={mode} onValueChange={modeChoice.choose}>
                    {INTAKE_MODES.map(m => (
                      <DropdownMenuRadioItem key={m.key} value={m.key} className="items-start">
                        <span>
                          <span className="block font-medium">{m.label}</span>
                          <span className="block text-xs text-muted-foreground">{m.hint}</span>
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" disabled={!idle || !factories?.length}
                    aria-label={madeIn ? `Where the parts are made: ${madeIn}` : 'Where the parts are made'} title="Where the parts are made"
                    className="h-9 shrink-0 gap-1 rounded-full px-3 text-sm font-medium text-foreground">
                    {madeIn || 'Made in'}
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                  <DropdownMenuLabel>Where the parts are made</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={madeIn} onValueChange={madeInChoice.choose}>
                    {(factories ?? []).map(f => <DropdownMenuRadioItem key={f.location} value={f.location}>{f.location} ({f.code})</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {dictation.available && (
                <Button type="button" variant={dictation.listening ? 'default' : 'ghost'} size="icon" aria-pressed={dictation.listening} disabled={!idle}
                  aria-label={dictation.listening ? 'Stop dictating' : 'Dictate'}
                  title={dictation.listening ? 'Listening. Press to stop.' : "Dictate what the job is (the browser's speech recognition)"}
                  className={`h-9 w-9 shrink-0 rounded-full ${dictation.listening ? 'animate-pulse' : 'text-muted-foreground'}`}
                  onClick={() => { if (dictation.listening) dictation.stop(); else { saidBefore.current = note; dictation.start(); } }}>
                  <Mic className="h-4 w-4" />
                </Button>
              )}
              <Button type="button" size="icon" aria-label={open && mode === 'build' ? 'Answer' : INTAKE_SEND[mode]} title={sendTitle}
                disabled={!canSend} onClick={send} className="h-9 w-9 rounded-full">
                {phase === 'reading' || working ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
        <div ref={foot} />
        {phase === 'compose' && thread.length === 0 && (
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
        {typedWhy && <p className="text-center text-xs text-destructive" role="alert">{typedWhy}</p>}
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
 * The conversation: what the person sent, what the build did and said, its questions, and what it made. One surface, so it reads over
 * the page's backdrop; the newest is at the foot, above the prompt.
 */
function Conversation({ thread, working, onAnswer, onClear }: { thread: Entry[]; working: boolean; onAnswer: (id: number, answer: Answer) => Promise<string | null>; onClear: () => void }) {
  return (
    <div aria-label="Conversation" className="space-y-4 rounded-3xl border border-border bg-card p-5 shadow-sm">
      {thread.map(entry => {
        if (entry.kind === 'user') {
          return (
            <div key={entry.id} className="flex flex-col items-end gap-2">
              {entry.files.length > 0 && (
                <ul className="flex flex-wrap items-end justify-end gap-2" aria-label="Files sent">
                  {entry.files.map(file => (isPicture(file.name) ? <PictureTile key={file.name} file={file} onRemove={null} /> : (
                    <li key={file.name} className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">
                      {intakeFileKind(file.name) === 'cad' ? <Box className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
                      <span className="break-all">{file.name}</span>
                    </li>
                  )))}
                </ul>
              )}
              {entry.text && <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm text-foreground">{entry.text}</p>}
            </div>
          );
        }
        if (entry.kind === 'step') return <Line key={entry.id} state={entry.state} title={entry.title} detail={entry.detail} />;
        if (entry.kind === 'say') return <p key={entry.id} className="whitespace-pre-wrap text-sm text-foreground">{entry.text}</p>;
        if (entry.kind === 'question') return <QuestionCard key={entry.id} entry={entry} onAnswer={given => onAnswer(entry.id, given)} />;
        const { result } = entry;
        return (
          <div key={entry.id} className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button asChild><Link href={`/projects/${result.projectId}/bom/${result.bomId}`}>Open the BOM</Link></Button>
            <Button variant="outline" onClick={onClear}>Start another</Button>
            <p className="text-sm text-muted-foreground">{result.parts.filter(p => p.costed).length} of {result.parts.length} parts costed.</p>
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
        <p>Every cost comes from the cost engines, never from the AI's words.</p>
        {thread.at(-1)?.kind !== 'result' && <button type="button" className="shrink-0 font-medium hover:text-foreground disabled:opacity-50" disabled={working} onClick={onClear}>Start over</button>}
      </div>
    </div>
  );
}

/**
 * A question the build asks: a few likely answers (the one the drawing supports is marked), the person's own words, and Skip. While
 * the person types, the answers their words match are offered. Once answered it is one line.
 */
function QuestionCard({ entry, onAnswer }: { entry: Extract<Entry, { kind: 'question' }>; onAnswer: (answer: Answer) => Promise<string | null> }) {
  const { question, answer } = entry;
  const [chosen, setChosen] = useState<string | null>(question.pick);
  const [own, setOwn] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  if (answer) {
    return (
      <p className="flex items-start gap-3 text-sm text-muted-foreground">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span><span className="font-medium text-foreground">{question.text}</span> {answer.action === 'skip' ? 'Skipped.' : answer.value}</span>
      </p>
    );
  }
  const words = own.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const offered = words.length > 0 && question.choices.length > 0
    ? question.choices.filter(choice => words.every(word => choice.toLowerCase().includes(word))).slice(0, 6).map(value => ({ value, why: undefined }))
    : question.options;
  const value = chosen ?? own.trim();
  const submit = async (given: Answer) => {
    setSending(true);
    setWhy(null);
    const refused = await onAnswer(given);
    setSending(false);
    if (refused) setWhy(refused);
  };
  return (
    <form aria-label={question.text} className="rounded-2xl border border-border bg-background shadow-sm" onSubmit={event => { event.preventDefault(); if (value !== '') void submit({ action: 'accept', value }); }}>
      <div className="border-b border-border px-4 py-3">
        <p className="font-medium text-foreground">{question.text}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{question.hint}</p>
      </div>
      <div className="space-y-1 p-3">
        {offered.map(option => (
          <label key={option.value} className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-sm ${chosen === option.value ? 'bg-muted' : 'hover:bg-muted/60'}`}>
            <input type="radio" name={`question-${entry.id}`} className="mt-1 accent-primary" checked={chosen === option.value} onChange={() => { setChosen(option.value); }} />
            <span className="min-w-0">
              <span className="font-medium text-foreground">{option.value}</span>
              {question.pick === option.value && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">EMITHRAN's pick</span>}
              {option.why && <span className="block text-muted-foreground">{option.why}</span>}
            </span>
          </label>
        ))}
        <Input value={own} aria-label="Your own answer" placeholder={question.choices.length > 0 ? 'Type to search, or write your own' : 'Write your own'}
          onChange={event => { setOwn(event.target.value); setChosen(null); }} />
        {why && <p className="px-1 text-sm text-destructive" role="alert">{why}</p>}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">{question.skip}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" disabled={sending} onClick={() => { void submit({ action: 'skip' }); }}>Skip</Button>
          <Button type="submit" disabled={sending || value === ''}>Submit</Button>
        </div>
      </div>
    </form>
  );
}

/** An added picture, shown as the picture itself in a small box, with its name for a screen reader and on hover. */
function PictureTile({ file, onRemove }: { file: File; onRemove: (() => void) | null }) {
  // The browser's own address for the file's bytes, made when the tile appears and given back when it goes.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => { URL.revokeObjectURL(made); };
  }, [file]);
  return (
    <li className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-border bg-muted" title={file.name}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a file held in the browser, not one Next can optimise */}
      {url ? <img src={url} alt={file.name} className="h-full w-full object-cover" /> : <ImageIcon className="m-auto h-full w-5 text-muted-foreground" aria-label={file.name} />}
      {onRemove && (
        <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove}
          className="absolute right-1 top-1 rounded-full border border-border bg-background/90 p-0.5 text-foreground shadow-sm hover:bg-background">
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
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
 * hidden; when the typing stops the placeholder is `still` again (the first example, or the Ask mode's own line).
 */
function useTypedPlaceholder(field: RefObject<HTMLTextAreaElement | null>, typing: boolean, still: string) {
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    // Written here as well as by React: the typing below writes to the field directly, and what it leaves must be this mode's text.
    node.placeholder = still;
    if (!typing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let tick = FIRST_HELD_TICK;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      tick += 1;
      node.placeholder = placeholderAt(tick);
    }, TYPING.tickMs);
    return () => { window.clearInterval(timer); node.placeholder = still; };
  }, [field, typing, still]);
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
