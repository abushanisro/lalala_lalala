'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, ArrowUp, Box, CheckCircle2, FileText, Image as ImageIcon, Loader2, Plus, Upload, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { drawingReadingsApi, type DrawingReading } from '@/lib/api/drawing-readings';
import { useFactories } from '@/lib/api/hooks/useFx';
import { useProcessCalculatorMappings } from '@/lib/api/hooks/useProcessCalculatorMappings';
import { useRawMaterials } from '@/lib/api/hooks/useRawMaterials';
import { PROCESS_MATERIALS, materialPickerQuery } from '@/lib/features/material-picker-query';
import { processGroupOptionsFrom } from '@/lib/features/process-group';
import { intakeApi } from '@/lib/intake/api';
import { FIRST_HELD_TICK, placeholderAt, STILL_PLACEHOLDER, TYPING } from '@/lib/intake/placeholder';
import {
  costable, gradeFor, INTAKE_ACCEPT, intakeFileKind, planBlockers, planPart, shapeSummary, type IntakePlan, type PlanPart,
} from '@/lib/intake/plan';
import { runIntake, type IntakeEvent, type IntakeResult } from '@/lib/intake/run';

type Phase = 'compose' | 'reading' | 'plan' | 'creating' | 'done';
/** What became of one dropped drawing: being read, read, not a drawing of a part, or not readable (with the server's reason). */
type Read = { state: 'reading' } | { state: 'read'; reading: DrawingReading } | { state: 'failed'; why: string };

const SELECT = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-60';
const LOCATION_KEY = 'intake.location';
const remembered = (): string => { try { return localStorage.getItem(LOCATION_KEY) ?? ''; } catch { return ''; } };
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
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useTypedPlaceholder(textarea, phase === 'compose' && note === '');

  const { data: factories } = useFactories();
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
      location: remembered(), annualVolume: null, batchSize: null, parts,
      cadFiles: files.filter(file => intakeFileKind(file.name) === 'cad').map(file => file.name),
    });
    setPhase('plan');
  };

  const create = async () => {
    if (!plan) return;
    try { if (plan.location) localStorage.setItem(LOCATION_KEY, plan.location); } catch { /* the choice is simply not remembered */ }
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
        <div
          onDragOver={event => { event.preventDefault(); if (phase === 'compose') setDragging(true); }}
          onDragLeave={() => { setDragging(false); }}
          onDrop={event => { event.preventDefault(); setDragging(false); if (phase === 'compose') add(event.dataTransfer.files); }}
          className={`rounded-3xl border bg-card shadow-lg transition-colors ${dragging ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}
        >
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
            <Button type="button" variant="ghost" size="icon" aria-label="Add files" title="Add drawings, pictures, STEP files or a zip" disabled={phase !== 'compose'}
              className="h-9 w-9 rounded-full text-muted-foreground" onClick={() => picker.current?.click()}>
              <Plus className="h-5 w-5" />
            </Button>
            <Button type="button" size="icon" aria-label="Read the files" title={files.length === 0 ? 'Add a file first' : 'Read the files'}
              disabled={phase !== 'compose' || files.length === 0} onClick={() => { void read(); }} className="h-9 w-9 rounded-full">
              {phase === 'reading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
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
