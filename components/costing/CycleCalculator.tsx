'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

import { useSourceRefEye } from '@/components/costing/SourceRefEye';
import { ChevronDown, ChevronRight, Pencil } from '@/components/ui/icons';
import type { CalculationTraceStep } from '@/lib/api/hooks/useBOMItems';
import { useClearCalculatorFieldOverride, useSetCalculatorFieldOverride } from '@/lib/api/hooks/useCalculatorFieldOverrides';
import { cycleFields, formatFieldValue, runsSetTogether, summedOperations, type OperationCalculation } from '@/lib/costing/cycle-fields';

const box = 'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm tabular-nums focus:outline-hidden focus:ring-1 focus:ring-primary/40';
const label = (s: CalculationTraceStep) => `${s.fieldName}${s.unit ? ` (${s.unit})` : ''}`;
const valued = (s: CalculationTraceStep) => `${s.fieldName} ${formatFieldValue(s.value)}${s.unit ? ` ${s.unit}` : ''}`;

/** The calculation on show, for every field of it: the whole trace, the part, and what is opened (kept here so a recalculation does not close it). */
interface View {
  trace: readonly CalculationTraceStep[];
  bomItemId: string;
  /** The line's stored calculator where the engine applies a part's own value to any field of it; null where it does not. */
  calculator: string | null;
  isOpen: (part: string) => boolean;
  toggle: (part: string) => void;
}
const ViewContext = createContext<View | null>(null);
function useView(): View {
  const view = useContext(ViewContext);
  if (!view) throw new Error('A calculation field is shown inside a CycleCalculator');
  return view;
}

/** A row that opens what is under it. */
function Disclosure({ part, className, children }: { part: string; className: string; children: ReactNode }) {
  const { isOpen, toggle } = useView();
  const open = isOpen(part);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button type="button" className={`flex items-start gap-1 text-left ${className}`} aria-expanded={open} onClick={() => { toggle(part); }}>
      <Chevron className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

/**
 * One field: its value and why it has it; the pencil opens an editor to set the part's own value (with the reason). A field that adds up
 * operations of their own (a mill line's Rough Milling Time) opens them under it.
 */
function Field({ step, children }: { step: CalculationTraceStep; children?: ReactNode }) {
  const { trace, bomItemId, calculator } = useView();
  const shown = formatFieldValue(step.value);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(shown);
  const [reason, setReason] = useState('');
  const set = useSetCalculatorFieldOverride(bomItemId);
  const clear = useClearCalculatorFieldOverride(bomItemId);
  // What the part's own value is kept under: the step's own calculator and field where the engine says it can be set, else any field of
  // the line's calculator where the engine applies them to all of it.
  const own = step.settable ?? (calculator && step.operation == null ? { calculator, field: step.fieldName } : null);
  const together = own ? runsSetTogether(trace, own) : 0;
  const num = Number(value);
  const valid = Number.isFinite(num) && num > 0 && value.trim() !== shown && reason.trim().length >= 3;
  const busy = set.isPending || clear.isPending;
  const failure = (set.error ?? clear.error) as { message?: string } | null;
  const why = step.override
    ? `Engineer's value for this part: ${step.override.reason}`
    : step.kind === 'calculated' ? `${step.fieldName} = ${step.formula ?? ''}` : step.source ?? '';
  const close = () => { setEditing(false); setValue(shown); setReason(''); };
  // An input's eye: where its value was read (its SourceRef), opened under it.
  const eye = useSourceRefEye(step);

  return (
    <div className="space-y-1 border-b border-border/30 pb-2 last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label(step)}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={`text-sm font-semibold tabular-nums ${step.override ? 'text-amber-600 dark:text-amber-500' : ''}`}>{shown}</span>
          {step.kind === 'input' && eye.button}
          {own && !editing && (
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`Edit ${step.fieldName} for this part`} title="Set this part's own value" onClick={() => { setEditing(true); }}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
      <p className={`text-xs leading-snug text-muted-foreground ${step.kind === 'calculated' && !step.override ? 'font-mono' : ''}`}>Why: {why}</p>
      {step.kind === 'input' && eye.panel}
      {step.override && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          The calculator gives {formatFieldValue(step.override.original)}{step.unit ? ` ${step.unit}` : ''}.{' '}
          {own && (
            <button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => { clear.mutate(own); }}>
              Back to the calculator&apos;s value
            </button>
          )}
        </p>
      )}
      {own && editing && (
        <form
          className="space-y-1.5 rounded-md bg-muted/40 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            set.mutate({ ...own, value: num, reason: reason.trim() }, { onSuccess: close });
          }}
        >
          <input className={box} inputMode="decimal" aria-label={`${label(step)} for this part`} value={value} autoFocus onChange={(e) => { setValue(e.target.value); }} />
          <input className={box} aria-label={`Why ${step.fieldName} differs for this part`} placeholder="Why this part differs (required)" value={reason} onChange={(e) => { setReason(e.target.value); }} />
          {together > 1 && (
            <p className="text-xs text-muted-foreground">Used by every {own.calculator} calculation of this part: {together} on this line.</p>
          )}
          <div className="flex gap-2 text-xs">
            <button type="submit" className="rounded-md bg-brand-600 px-3 py-1 font-medium text-white disabled:opacity-50" disabled={busy || !valid}>
              {set.isPending ? 'Saving…' : 'Save and recalculate'}
            </button>
            <button type="button" className="text-muted-foreground hover:underline" onClick={close}>Cancel</button>
          </div>
          {value.trim() !== '' && (!Number.isFinite(num) || num <= 0) && <p className="text-xs text-red-600">Enter a positive number.</p>}
        </form>
      )}
      {failure?.message && <p className="text-xs text-red-600">{failure.message}</p>}
      {(step.sumOf?.length ?? 0) > 0 && <Operations step={step} />}
      {children}
    </div>
  );
}

const fieldKey = (s: CalculationTraceStep) => `${s.fieldName}:${String(s.value)}`;

/** One operation of a time: its name, what was measured on the part for it, and its time; opened, its own calculation field by field. */
function Operation({ of: o }: { of: OperationCalculation }) {
  const { isOpen } = useView();
  const part = `operation:${o.operation}`;
  const measured = o.measured.slice(0, 4).map(valued).join(' · ') + (o.measured.length > 4 ? ' · …' : '');
  const inputs = o.steps.filter((s) => s.kind === 'input');
  const results = o.steps.filter((s) => s.kind === 'calculated');
  return (
    <div className="border-b border-border/30 pb-1.5 last:border-0">
      <Disclosure part={part} className="w-full text-sm">
        <span className="min-w-0 flex-1">
          <span className="font-medium">{o.name}{o.count != null && o.count > 1 ? ` × ${o.count}` : ''}</span>
          {measured && <span className="block text-xs text-muted-foreground">{measured}</span>}
        </span>
        <span className="shrink-0 font-semibold tabular-nums">{formatFieldValue(o.seconds)} s</span>
      </Disclosure>
      {isOpen(part) && (
        <div className="mt-1.5 space-y-2 rounded-md bg-muted/30 p-2">
          {o.steps.length === 0 && <p className="text-xs text-muted-foreground">Timed without a calculator: it has no steps of its own.</p>}
          {inputs.length > 0 && <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Inputs</div>}
          {inputs.map((s) => <Field key={fieldKey(s)} step={s} />)}
          {results.length > 0 && <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Calculated from them</div>}
          {results.map((s) => <Field key={fieldKey(s)} step={s} />)}
          {o.factor != null && (
            <p className="text-xs text-muted-foreground">Its calculated time × {formatFieldValue(o.factor)}, for the surface finish the drawing asks for: {formatFieldValue(o.seconds)} s.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The operations a time adds up, under it: each with its time, and their sum, which is the time. */
function Operations({ step }: { step: CalculationTraceStep }) {
  const { trace, isOpen } = useView();
  const part = `sum:${step.fieldName}`;
  const operations = summedOperations(trace, step);
  return (
    <div>
      <Disclosure part={part} className="text-xs font-medium text-primary hover:underline">
        How it is calculated: {operations.length} operation{operations.length === 1 ? '' : 's'}
      </Disclosure>
      {isOpen(part) && (
        <div className="mt-1.5 space-y-1.5 border-l-2 border-primary/30 pl-3">
          {operations.map((o) => <Operation key={o.operation} of={o} />)}
          <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
            <span>{step.fieldName} = {operations.length === 1 ? 'this operation' : `the sum of these ${operations.length} operations`}</span>
            <span className="shrink-0 font-semibold tabular-nums text-foreground">{formatFieldValue(step.value)}{step.unit ? ` ${step.unit}` : ''}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The cycle of a calculator-driven operation in the Cost panel: each phase its Cycle Time formula adds up and, on request, every other field of the
 * calculation, then the Cycle Time itself with its formula, last, as their total. A phase that adds up times of operations of their own (a mill line's
 * Cutting Time) lists them under it, and each opens its operations and their own calculations. Where the engine applies a part's own values (`calculator`
 * set, or a step it marks as settable), the field can be changed for this part with the reason; the cost is recalculated with it. Read-only otherwise.
 */
export function CycleCalculator({ trace, bomItemId, calculator, result, first }: {
  trace: readonly CalculationTraceStep[]; bomItemId: string; calculator: string | null;
  /** The result field, last (default: the Cycle Time or Total Time); `first`: the fields shown first (default: the ones its formula names). */
  result?: string; first?: readonly string[];
}) {
  const [more, setMore] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const fields = cycleFields(trace, { ...(result ? { result } : {}), ...(first ? { first } : {}) });
  if (!fields) return null;
  const view: View = {
    trace, bomItemId, calculator,
    isOpen: (part) => opened.has(part),
    toggle: (part) => { setOpened((was) => { const now = new Set(was); if (!now.delete(part)) now.add(part); return now; }); },
  };
  const settable = !!calculator || trace.some((s) => s.settable);
  return (
    <ViewContext.Provider value={view}>
      <div className="space-y-3 rounded-lg border border-border p-3">
        {fields.phases.map((s) => {
          const summed = fields.summed.get(s.fieldName) ?? [];
          return (
            <Field key={fieldKey(s)} step={s}>
              {summed.length > 0 && (
                <div className="mt-2 space-y-2 border-l-2 border-border pl-3">
                  {summed.map((part) => <Field key={fieldKey(part)} step={part} />)}
                </div>
              )}
            </Field>
          );
        })}
        {fields.others.length > 0 && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setMore((v) => !v); }} aria-expanded={more}>
            {more ? 'Hide the other inputs' : `Show the ${fields.others.length} other inputs and values`}
          </button>
        )}
        {more && fields.others.map((s) => <Field key={fieldKey(s)} step={s} />)}
        <div className="flex items-start justify-between gap-3 rounded-md bg-muted/40 p-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{label(fields.cycle)}</div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground break-words">Why: {fields.cycle.fieldName} = {fields.cycle.formula}</p>
          </div>
          <div className="shrink-0 text-lg font-bold tabular-nums text-primary">{formatFieldValue(fields.cycle.value)}</div>
        </div>
        {settable && <p className="text-[11px] text-muted-foreground">A changed value is this part&apos;s own, kept with its reason; press Apply to put the recalculated cost in the quote.</p>}
      </div>
    </ViewContext.Provider>
  );
}
