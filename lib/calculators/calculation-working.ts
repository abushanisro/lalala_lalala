// How a calculation reaches its result, written out the way a worked example is: every calculated field the result is built from, in the
// order it is computed, with its formula in field names and again in the numbers used. Read from a calculation's trace (each input and
// calculated field with its value), which the dialog has for the open calculator (runOfCalculator) and a line keeps for every group it ran
// its calculator on (calculator_run). Nothing is computed here: each value shown is the one the calculator returned. Pure.
import type { CalculationTraceStep } from '@/lib/api/hooks/useBOMItems';

export interface WorkingStep {
  fieldName: string;
  unit: string | null;
  /** The formula in field names: "{Rough Passes} * {Time per Pass}" reads "Rough Passes × Time per Pass". */
  formula: string | null;
  /** The same with each field's value in its place: "2 × 0.050234". Null when the formula names no field that has a value. */
  withValues: string | null;
  value: number | string | null;
}

/** One group a line ran its calculator on (a turned diameter, a hole size): its steps, the last of them its result. */
export interface GroupWorking {
  label: string;
  steps: WorkingStep[];
  result: WorkingStep | null;
}

/** A line timed by one calculator run per group: every group's working and the line's own total of them. */
export interface LineWorking {
  groups: GroupWorking[];
  total: WorkingStep | null;
}

const RESULT_FIELDS = ['Cycle Time', 'Total Time'];
const FIELD_REF = /\{([^}]+)\}/g;

/** Live calculators carry the unit in the field name ("Cycle Time (sec)"): a name is matched without its trailing "(unit)". */
const baseName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim();

/** A number as a worked example writes it: five significant figures (15.875, 0.050234), two decimals from 100 up (11300.28). */
export function workingNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) >= 100
    ? String(Math.round(v * 100) / 100)
    : v.toLocaleString('en-US', { maximumSignificantDigits: 5, useGrouping: false });
}

/** A formula as it is read rather than typed: × for *, − for a spaced -, π for pi. */
const readable = (expression: string) => expression
  .replace(/^\s*=\s*/, '')
  .replace(/\s*\*\s*/g, ' × ')
  .replace(/ - /g, ' − ')
  .replace(/\bpi\b/gi, 'π');

/**
 * The calculated fields a result is built from, each after the ones its formula names, ending with the result itself. The result is the
 * calculation's Cycle Time or Total Time unless `result` names another field. Empty when the trace has no such calculated field.
 */
export function workingOf(trace: readonly CalculationTraceStep[] | null | undefined, result?: string): WorkingStep[] {
  if (!trace?.length) return [];
  const byName = new Map<string, CalculationTraceStep>();
  for (const s of trace) byName.set(s.fieldName, s);
  for (const s of trace) if (!byName.has(baseName(s.fieldName))) byName.set(baseName(s.fieldName), s);
  const find = (name: string) => byName.get(name) ?? byName.get(baseName(name));

  const target = result
    ? find(result)
    : [...trace].reverse().find((s) => s.kind === 'calculated' && RESULT_FIELDS.includes(baseName(s.fieldName)));
  if (target?.kind !== 'calculated') return [];

  const valueText = (name: string): string | null => {
    const v = find(name)?.value;
    if (typeof v === 'number') return workingNumber(v);
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  };
  const steps: WorkingStep[] = [];
  const seen = new Set<string>();
  const visit = (step: CalculationTraceStep) => {
    if (seen.has(step.fieldName)) return;
    seen.add(step.fieldName);
    const formula = step.formula ?? '';
    const names = [...formula.matchAll(FIELD_REF)].map((m) => m[1] ?? '');
    for (const name of names) {
      const dependency = find(name);
      if (dependency?.kind === 'calculated') visit(dependency);
    }
    steps.push({
      fieldName: step.fieldName,
      unit: step.unit ?? null,
      formula: formula ? readable(formula.replace(FIELD_REF, (_, name: string) => name)) : null,
      withValues: names.some((name) => valueText(name) !== null)
        ? readable(formula.replace(FIELD_REF, (_, name: string) => valueText(name) ?? name))
        : null,
      value: step.value,
    });
  };
  visit(target);
  return steps;
}

/**
 * A line that ran its calculator once per group, group by group: each group's working under the calculator's own field names, and the
 * line's total of them (the first calculated step after the groups, with the formula the engine recorded for it). Null for a line of one
 * run: its working is the calculator's own.
 */
export function lineWorkingOf(trace: readonly CalculationTraceStep[] | null | undefined): LineWorking | null {
  const labels = [...new Set((trace ?? []).flatMap((s) => (s.group ? [s.group] : [])))];
  if (!trace || labels.length < 2) return null;
  const groups = labels.map((label): GroupWorking => {
    const steps = workingOf(trace.filter((s) => s.group === label).map((s) => ({ ...s, fieldName: s.groupField ?? s.fieldName })));
    return { label, steps, result: steps.at(-1) ?? null };
  });
  const lastGrouped = trace.reduce((last, s, i) => (s.group ? i : last), -1);
  const total = trace.slice(lastGrouped + 1).find((s) => s.kind === 'calculated');
  // The groups' results written as the sum, only where the line's total is that sum (a hole line adds tool changes and an allowance).
  const results = groups.map((g) => g.result?.value);
  const sum = results.every((v): v is number => typeof v === 'number') ? results.reduce((a, b) => a + b, 0) : null;
  const isSum = sum !== null && typeof total?.value === 'number' && Math.abs(sum - total.value) <= Math.max(Math.abs(total.value) * 0.005, 1e-4);
  return {
    groups,
    total: total ? {
      fieldName: total.fieldName, unit: total.unit ?? null, formula: total.formula ?? null,
      withValues: isSum ? (results as number[]).map(workingNumber).join(' + ') : null, value: total.value,
    } : null,
  };
}

/** A calculator field as the dialog has it (lib/api/calculators.ts CalculatorField): a calculated field's formula is its default value. */
interface CalculatorFieldLike {
  fieldName: string;
  displayLabel?: string | null;
  fieldType: string;
  unit?: string | null;
  defaultValue?: string | null;
}

const numberOr = (v: unknown): number | string | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : v;
};

/**
 * The open calculator as a trace: each input with the value the result was calculated from (its default where it was left blank, as the
 * calculator itself takes it), each calculated field with its formula and the result returned for it (none for one that failed).
 */
export function traceOfCalculator(
  fields: readonly CalculatorFieldLike[],
  inputs: Readonly<Record<string, unknown>>,
  results: Readonly<Record<string, unknown>> | null | undefined,
): CalculationTraceStep[] {
  return fields.map((f): CalculationTraceStep => {
    const base = { fieldName: f.fieldName, displayLabel: f.displayLabel ?? f.fieldName, unit: f.unit ?? null };
    if (f.fieldType !== 'calculated') return { ...base, kind: 'input', value: numberOr(inputs[f.fieldName]) ?? numberOr(f.defaultValue) };
    const raw = results?.[f.fieldName];
    const result = raw && typeof raw === 'object' ? ('error' in raw ? null : (raw as { value?: unknown }).value) : raw;
    return { ...base, kind: 'calculated', value: numberOr(result), ...(f.defaultValue ? { formula: f.defaultValue } : {}) };
  });
}

/** Every calculated field's formula written in the numbers used, by field name (only the fields that have one). */
export function formulaNumbers(trace: readonly CalculationTraceStep[]): Record<string, string> {
  return Object.fromEntries(trace.flatMap((s) => {
    const numbers = s.kind === 'calculated' ? workingOf(trace, s.fieldName).at(-1)?.withValues : null;
    return numbers ? [[s.fieldName, numbers]] : [];
  }));
}
