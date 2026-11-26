import type { CalculationTraceStep } from '@/lib/api/hooks/useBOMItems';

const CYCLE_FIELDS = ['Cycle Time', 'Total Time'];

export interface CycleFields {
  /** The line's Cycle Time (or Total Time): the result. */
  cycle: CalculationTraceStep;
  /** The fields the cycle formula names, in formula order: the phases. */
  phases: CalculationTraceStep[];
  /**
   * Per phase (by field name), the inputs its formula names that add up operations of their own (a mill line's Rough Milling Time under
   * its Cutting Time): shown under the phase, each opening its operations (summedOperations).
   */
  summed: Map<string, CalculationTraceStep[]>;
  /** Every other field of the calculation, in the calculator's order. */
  others: CalculationTraceStep[];
}

/** The fields a formula names ("{Cuts} * {Time per Cut}"), in its order, once each. */
const namedIn = (formula: string | null | undefined): string[] => [...new Set([...(formula ?? '').matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? ''))];

/**
 * A calculation as the Cost panel lays it out: the result (by default the Cycle Time or Total Time), the fields shown first (by default the ones the
 * result's formula names: a cycle's phases), and the rest in the calculator's order. Null when the calculation has no such result. The steps of the
 * operations a line adds up are not fields of the line: they are shown under the input that adds them (summedOperations).
 */
export function cycleFields(all: readonly CalculationTraceStep[] | null | undefined, opts: { result?: string; first?: readonly string[] } = {}): CycleFields | null {
  const trace = all?.filter((s) => s.operation == null);
  const results = opts.result ? [opts.result] : CYCLE_FIELDS;
  const cycle = [...(trace ?? [])].reverse().find((s) => s.kind === 'calculated' && results.includes(s.fieldName));
  if (!cycle || !trace) return null;
  const byName = new Map(trace.map((s) => [s.fieldName, s]));
  const names = opts.first ? [...opts.first] : namedIn(cycle.formula);
  const phases = names.flatMap((n) => { const s = byName.get(n); return s ? [s] : []; });
  const taken = new Set([cycle.fieldName, ...phases.map((p) => p.fieldName)]);
  const summed = new Map<string, CalculationTraceStep[]>();
  for (const phase of phases) {
    if (phase.kind !== 'calculated') continue;
    const parts = namedIn(phase.formula).flatMap((n) => { const s = byName.get(n); return s?.sumOf?.length && !taken.has(n) ? [s] : []; });
    if (parts.length === 0) continue;
    summed.set(phase.fieldName, parts);
    for (const p of parts) taken.add(p.fieldName);
  }
  return { cycle, phases, summed, others: trace.filter((s) => !taken.has(s.fieldName)) };
}

/** One operation a line input adds up, with its own calculation. */
export interface OperationCalculation {
  /** Its place in the line's sequence (two pockets rough milled are two operations of one name). */
  operation: number;
  name: string;
  /** Its time on the line (s), as the input adds it. */
  seconds: number;
  /** The features (or holes) it cuts, when counted. */
  count: number | null;
  /** A factor the drawing put on its calculated time, already in `seconds`; null for none. */
  factor: number | null;
  /** Its steps in the calculator's order, each under its own field name (the operation's name taken off the front). */
  steps: CalculationTraceStep[];
  /** What was measured on the part for it (a pocket's length, width and depth): what tells it from an operation of the same name. */
  measured: CalculationTraceStep[];
}

/** Where a measurement of this part is read: its CAD faces or features, or a calculation over them. Any other source is a parameter. */
const MEASURED_ON_THE_PART = new Set(['features', 'faces', 'cad', 'calculation']);

/**
 * The operations an input adds up (step.sumOf), each with its own steps from the line's calculation; none for any other step. An
 * operation timed without a calculator has no steps, only its time.
 */
export function summedOperations(trace: readonly CalculationTraceStep[], step: CalculationTraceStep): OperationCalculation[] {
  return (step.sumOf ?? []).map((o) => {
    const steps = trace.filter((s) => s.operation === o.operation).map((s) => {
      // "Rough Milling · Cut Length" under the Rough Milling operation is its "Cut Length"; a run's own label stays ("Edge 3 mm · Edge Length").
      const prefix = s.group ? `${s.group} · ` : '';
      const own = prefix && s.fieldName.startsWith(prefix) ? s.fieldName.slice(prefix.length) : s.fieldName;
      return { ...s, fieldName: own, displayLabel: own };
    });
    return {
      operation: o.operation, name: o.name, seconds: o.seconds, count: o.count ?? null, factor: o.factor ?? null, steps,
      // A value the engineer set for the part opens as a calculation too (what it replaced): it is a parameter, not a measurement.
      measured: steps.filter((s) => s.kind === 'input' && !s.override && !s.settable && !!s.ref && MEASURED_ON_THE_PART.has(s.ref.kind)),
    };
  });
}

/** How many steps of the calculation are the same field of the same stored calculator: a part's own value for it is used by every one. */
export function runsSetTogether(trace: readonly CalculationTraceStep[], settable: { calculator: string; field: string }): number {
  return trace.filter((s) => s.settable?.calculator === settable.calculator && s.settable.field === settable.field).length;
}

/** A field's value as the panel shows it: up to four significant digits, so a phase keeps its precision (2.9 s is not 3 s). */
export function formatFieldValue(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return v;
  return Math.abs(v) >= 100 ? String(Math.round(v * 100) / 100) : v.toLocaleString('en-US', { maximumSignificantDigits: 3, useGrouping: false });
}
