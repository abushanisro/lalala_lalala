import {
  evaluateCalculatorFormulas,
  normalizeFieldName,
  type CalculatorFieldRow,
} from '../../../../calculators/calculator-formula-evaluator';
import type { CalculationTraceStep, CalculatorFieldDefault, ProcessLineCost, SourceRef } from '../../../dto/cost-breakdown.dto';

/**
 * Reference-data calculators (Machining, Die Casting, ...) are computed BY the
 * database calculators (calculators / calculator_fields, wired per operation in
 * process_calculator_mappings, generated from each domain's calculator spec).
 * The engine never holds the formula: it supplies each calculator's inputs (CAD
 * measurements, alloy and machine values, reference variables and lookup-table
 * rows, each with its source) and evaluates the calculator's own stored
 * formulas with the same evaluator the cost dialogs run
 * (calculator-formula-evaluator.ts), so the quote and the dialogs cannot
 * disagree.
 */
export interface ReferenceCalculatorField {
  field_name: string;
  display_label?: string | null;
  field_type: string;
  default_value?: string | number | null;
  unit?: string | null;
  display_order?: number | null;
  data_source?: string | null;
  source_table?: string | null;
  source_field?: string | null;
  /**
   * Where the field's default value comes from (a workbook sheet, a published source), named: the calculator spec's `note` for the field,
   * laid over the database row by whoever loads the calculator (the database has no column for it). Null or absent: not yet sourced.
   */
  note?: string | null;
}

export interface ReferenceCalculatorDef {
  calculatorId: string;
  name: string;
  version: number;
  fields: ReferenceCalculatorField[];
  /** A part's own values for some of its fields, by field name (calculator_field_overrides, migration 1011): set with withFieldOverrides. */
  overrides?: Readonly<Record<string, FieldOverride>>;
}

/** A part's own value for one calculator field, with the reason (calculator_field_overrides). */
export interface FieldOverride {
  value: number;
  reason: string;
}

/** Per calculator name, the part's own field values. */
export type CalculatorFieldOverrides = Readonly<Record<string, Readonly<Record<string, FieldOverride>>>>;

/**
 * The calculators with a part's own field values laid over them, for one calculation. The stored definitions are never edited: a calculator with
 * overrides is a copy, the others are the same objects. No overrides: the calculators as given.
 */
export function withFieldOverrides(calculators: ReferenceCalculators | null | undefined, overrides: CalculatorFieldOverrides | null | undefined): ReferenceCalculators | null | undefined {
  if (!calculators || !overrides || Object.keys(overrides).length === 0) return calculators;
  return Object.fromEntries(Object.entries(calculators).map(([key, def]) => {
    const own = overrides[def.name];
    return [key, own && Object.keys(own).length > 0 ? { ...def, overrides: own } : def];
  }));
}

const overrideSource = (o: FieldOverride, was: string) => `Engineer's value for this part: ${o.reason} (instead of ${was})`;

/**
 * Where a field the part overrides takes its value: the engineer's value set on this part (calculator_field_overrides, with its reason), and the
 * value it replaces with that value's own source (the seed's ref, else the calculator's table of defaults); the value in use is the engineer's.
 */
function overrideRef(def: ReferenceCalculatorDef, f: ReferenceCalculatorField, own: FieldOverride, seeded: CalcSeed | undefined): SourceRef {
  const unit = f.unit ?? null;
  const label = (name: string) => (unit ? `${name} (${unit})` : name);
  const replaced: CalculationTraceStep | null = seeded && Number.isFinite(seeded.value)
    ? { fieldName: 'Value it replaces', displayLabel: label('Value it replaces'), kind: 'input', value: round(seeded.value), unit, source: seeded.source, ...(seeded.ref ? { ref: seeded.ref } : {}) }
    : hasValue(f.default_value) && Number.isFinite(Number(f.default_value))
      ? {
        fieldName: 'Value it replaces', displayLabel: label('Value it replaces'), kind: 'input', value: Number(f.default_value), unit,
        source: calculatorDefaultSource(def.name, f.note), ref: calculatorFieldRef(def, f.field_name),
      }
      : null;
  return {
    kind: 'calculation', name: `${f.field_name}: set by the engineer on this part`, evidence: null,
    steps: [
      { fieldName: 'Set for this part', displayLabel: label('Set for this part'), kind: 'input', value: round(own.value), unit, source: `The engineer's value for this part (calculator field override): ${own.reason}` },
      ...(replaced ? [replaced] : []),
      { fieldName: f.field_name, displayLabel: label(f.field_name), kind: 'calculated', value: round(own.value), unit, formula: 'The engineer\'s value for this part, used instead of the value it replaces' },
    ],
  };
}

/** Calculator per operation / calculator key ("Drilling", "High Pressure Die Casting", ...). */
export type ReferenceCalculators = Record<string, ReferenceCalculatorDef>;

/** One input value the engine supplies, with where it came from. */
export interface CalcSeed {
  value: number;
  source: string;
  /** True when the value is a row of a reference lookup table. */
  lookup?: boolean;
  /** Which lookup-table row(s) the value came from: every column/value in `row` identifies them. */
  match?: LookupMatch;
  /** Where the value was read, structured, so the calculator dialog can open and highlight it (SourceRef). */
  ref?: SourceRef;
}

/** The lookup-table row(s) an input came from, for highlighting in the table viewer. */
export interface LookupMatch {
  table: string;
  row: Record<string, string | number>;
}

/** The CAD faces a source rests on: a CAD measurement, or a calculation over one (Poured Weight over the part volume). */
function evidenceOf(ref: SourceRef): CalculationTraceStep['evidence'] | null {
  if (ref.kind === 'cad') return ref.evidence;
  if (ref.kind === 'calculation') return ref.evidence;
  return null;
}

export interface CalcRun {
  /** The calculator's "Cycle Time" (s), or its declared output; null when an input or the calculator is missing. */
  sec: number | null;
  trace: CalculationTraceStep[];
  /** Missing real inputs (or the missing calculator), for the line's gap. */
  missing: string[];
  calculatorId: string | null;
  calculatorVersion: number | null;
  /** Per input field, the lookup-table row(s) its value came from. */
  lookups: Record<string, LookupMatch>;
}

/** A run with its declared output and every calculated field's value (secondary outputs: a force, a scrap %). */
export interface ReferenceCalcRun extends CalcRun {
  value: number | null;
  outputs: Record<string, number>;
}

export const CYCLE_TIME_FIELD = 'Cycle Time';

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== '';

/** The step source of a field that takes its calculator's default: where that value comes from, or that it is not yet sourced. */
export function calculatorDefaultSource(calculator: string, note: string | null | undefined): string {
  return note?.trim() ? note.trim() : `${calculator}'s own value for this field — not yet sourced`;
}

const defaultsCache = new WeakMap<object, CalculatorFieldDefault[]>();

/** A calculator's input fields that have a default value, each with that value, its unit and where it comes from (calculatorField's table). */
export function calculatorFieldDefaults(def: Pick<ReferenceCalculatorDef, 'fields'>): CalculatorFieldDefault[] {
  const cached = defaultsCache.get(def.fields);
  if (cached) return cached;
  const rows = [...def.fields]
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    .filter((f) => f.field_type !== 'calculated' && hasValue(f.default_value))
    .map((f) => ({
      field: f.field_name,
      value: Number.isFinite(Number(f.default_value)) ? Number(f.default_value) : String(f.default_value),
      unit: f.unit ?? null,
      source: f.note?.trim() ? f.note.trim() : null,
    }));
  defaultsCache.set(def.fields, rows);
  return rows;
}

/** The ref of a value that is the calculator's own default for the field: its table of defaults, that field's row outlined. */
export function calculatorFieldRef(def: Pick<ReferenceCalculatorDef, 'name' | 'fields'>, field: string): SourceRef {
  return { kind: 'calculatorField', calculator: def.name, field, defaults: calculatorFieldDefaults(def) };
}

/**
 * A field's default as a seed, for an engine that states the default itself (a turning calculator's approach allowance): its value, where it
 * comes from, and the calculator's table of defaults to open. Null when the calculator has no such field or it has no numeric default.
 */
export function calculatorDefaultSeed(calculators: ReferenceCalculators | null | undefined, operation: string, field: string): CalcSeed | null {
  const def = calculators?.[operation];
  const f = def?.fields.find((x) => x.field_name === field && x.field_type !== 'calculated');
  if (!def || !f || !hasValue(f.default_value) || !Number.isFinite(Number(f.default_value))) return null;
  return { value: Number(f.default_value), source: calculatorDefaultSource(def.name, f.note), ref: calculatorFieldRef(def, field) };
}

export function runReferenceCalculator(
  calculators: ReferenceCalculators | null | undefined,
  operation: string,
  seeds: Record<string, CalcSeed>,
  outputField: string = CYCLE_TIME_FIELD,
): ReferenceCalcRun {
  const def = calculators?.[operation];
  if (!def) {
    return {
      value: null, sec: null, outputs: {}, trace: [], calculatorId: null, calculatorVersion: null, lookups: {},
      missing: [`a calculator for "${operation}" (none mapped in process_calculator_mappings)`],
    };
  }

  const ordered = [...def.fields].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const inputs: CalculationTraceStep[] = [];
  const scope: Record<string, number> = {};
  const missingInputs: string[] = [];
  const lookups: Record<string, LookupMatch> = {};

  for (const f of ordered) {
    if (f.field_type === 'calculated') continue;
    const own = def.overrides?.[f.field_name];
    const seeded = seeds[f.field_name];
    const seed: CalcSeed | undefined = own
      ? { value: own.value, source: overrideSource(own, seeded ? `${round(seeded.value)}, ${seeded.source}` : 'no seeded value') }
      : seeded;
    if (seed && Number.isFinite(seed.value)) {
      scope[f.field_name] = seed.value;
      if (seed.match) lookups[f.field_name] = seed.match;
      inputs.push({
        fieldName: f.field_name, displayLabel: f.display_label ?? f.field_name, kind: 'input',
        value: round(seed.value), unit: f.unit ?? null, source: seed.source,
        ...(seed.lookup ? { stepType: 'lookup' as const } : {}),
        // A value the part's own override replaced was not read from the seed's source: its eye opens the override instead, and the value it replaces.
        ...(seed.ref && !own ? { ref: seed.ref, ...(evidenceOf(seed.ref) ? { evidence: evidenceOf(seed.ref)! } : {}) } : {}),
        ...(own ? { ref: overrideRef(def, f, own, seeded) } : {}),
        ...(own ? { override: { original: seeded && Number.isFinite(seeded.value) ? round(seeded.value) : null, reason: own.reason } } : {}),
      });
    } else if (hasValue(f.default_value) && Number.isFinite(Number(f.default_value))) {
      scope[f.field_name] = Number(f.default_value);
      // The calculator's own value: where it comes from (the spec's note), and its table of defaults for the eye.
      inputs.push({
        fieldName: f.field_name, displayLabel: f.display_label ?? f.field_name, kind: 'input',
        value: Number(f.default_value), unit: f.unit ?? null,
        source: calculatorDefaultSource(def.name, f.note),
        ref: calculatorFieldRef(def, f.field_name),
      });
    } else {
      missingInputs.push(f.field_name);
    }
  }

  const base = { calculatorId: def.calculatorId, calculatorVersion: def.version, lookups };
  if (missingInputs.length > 0) {
    return { ...base, value: null, sec: null, outputs: {}, trace: inputs, missing: [`${operation}: ${missingInputs.join(', ')}`] };
  }

  const rows: CalculatorFieldRow[] = ordered.map((f) => ({
    id: f.field_name, field_name: f.field_name, field_type: f.field_type,
    default_value: f.default_value ?? null, display_order: f.display_order ?? null,
  }));
  // A calculated field the part sets is evaluated first as the calculator states it (the trace shows what it would have been), then fixed at the part's
  // value as an input, so every later formula uses it.
  const calcOverrides = ordered.filter((f) => f.field_type === 'calculated' && def.overrides?.[f.field_name]);
  const stated = calcOverrides.length > 0 ? evaluateCalculatorFormulas(rows, [], { ...scope }).scope : null;
  const fixed = Object.fromEntries(calcOverrides.map((f) => [f.field_name, def.overrides![f.field_name]!.value]));
  const { scope: out } = evaluateCalculatorFormulas(
    rows.map((r) => (r.field_name in fixed ? { ...r, field_type: 'number', default_value: null } : r)),
    [],
    { ...scope, ...fixed },
  );
  for (const [name, v] of Object.entries(fixed)) out[normalizeFieldName(name)] = v;

  const outputs: Record<string, number> = {};
  const formulas: CalculationTraceStep[] = ordered
    .filter((f) => f.field_type === 'calculated')
    .map((f) => {
      const v = out[normalizeFieldName(f.field_name)];
      const finite = typeof v === 'number' && Number.isFinite(v);
      if (finite) outputs[f.field_name] = v as number;
      const own = def.overrides?.[f.field_name];
      const was = stated?.[normalizeFieldName(f.field_name)];
      return {
        fieldName: f.field_name, displayLabel: f.display_label ?? f.field_name, kind: 'calculated' as const,
        value: finite ? round(v as number) : null,
        unit: f.unit ?? null, formula: String(f.default_value ?? ''), stepType: 'physics' as const,
        ...(own ? { source: overrideSource(own, 'the formula'), override: { original: typeof was === 'number' && Number.isFinite(was) ? round(was) : null, reason: own.reason } } : {}),
      };
    });

  const value = out[normalizeFieldName(outputField)];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return {
      ...base, value: null, sec: null, outputs, trace: [...inputs, ...formulas],
      missing: [`${def.name} produced no finite ${outputField.toLowerCase()} from these inputs`],
    };
  }
  return { ...base, value, sec: value, outputs, trace: [...inputs, ...formulas], missing: [] };
}

function round(v: number): number {
  return Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000;
}

/** The fields a process line carries from the calculator that computed it. */
export function runOnLine(run: CalcRun): Pick<ProcessLineCost, 'calculationTrace' | 'lookupMatches' | 'calculatorId' | 'calculatorVersion'> {
  return {
    calculationTrace: run.trace,
    ...(Object.keys(run.lookups).length ? { lookupMatches: run.lookups } : {}),
    ...(run.calculatorId ? { calculatorId: run.calculatorId } : {}),
    ...(run.calculatorVersion != null ? { calculatorVersion: run.calculatorVersion } : {}),
  };
}
