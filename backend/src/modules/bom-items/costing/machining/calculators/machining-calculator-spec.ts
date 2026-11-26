import spec from './machining-calculators.json';
import type { MachiningCalculatorField, MachiningCalculators } from './machining-calculator';

/**
 * The machining calculator spec (machining-calculators.json), expanded:
 * machine-class group names resolved and "sameFieldsAs" copies filled in.
 * Read by the migration generator (scripts/generate-machining-calculators-
 * migration.ts) and by tests. The running engine reads the calculators from
 * the database; it uses the spec only for which machine classes are machining
 * stations (bom-items.service.ts resolveMachiningCalculators) and which lookup
 * tables the calculators name (machining-lookup-tables.ts).
 */
export interface SpecField {
  name: string;
  unit: string | null;
  source?: 'cad' | 'lookup' | 'machine' | 'bom' | 'drawing' | 'engine' | 'default';
  table?: string;
  /** Other tables the same input can come from (the trace names the one used). */
  alsoTables?: string[];
  column?: string;
  /** A lookup row is the material's row that also has these column values (tblShaping "Cut Type": 1). */
  where?: Record<string, string | number>;
  /** A lookup row is the material's row whose `column` is nearest the product of these inputs (the bevel cutter diameter nearest Module x Teeth). */
  nearest?: { column: string; product: string[] };
  /** A lookup row is the one whose `materialType` column names the material's type (tblChemicalMillingEtchingRates "material_type": Aluminum). */
  materialType?: string;
  /** A lookup row is the first, in ascending order of `column`, that reaches the input's value (the tblChemicalMilling row for a part of this area). */
  band?: { column: string; input: string };
  /**
   * A machining workbook table's row is the material's: its `column` holds the name the material class is mapped to in
   * tblCuttingMaterialGroup's `map` column (tblTurningConditions "WorkGroup": "Mild steels"). No name mapped = a named gap.
   */
  group?: { column: string; map: 'TurningGroup' | 'DrillReamMaterial' | 'HssGroup' | 'MillingMaterial' };
  /** A lookup row is the one whose `min`..`max` band holds the input's value (the workbook's depth-of-cut and hole-diameter bands). */
  range?: { min: string; max: string; input: string };
  default?: number;
  formula?: string;
  /**
   * Where a default the reference data has no value for comes from (a published source, named). Kept in the spec and written into the header of
   * the migration that ships the calculator; the database has no column for it, so the calculator's description says it too.
   */
  note?: string;
}

/** An operation written as this in the spec is the station itself: the calculator prices the machine's own line ("3 Axis Mill"). */
export const STATION_OPERATION = '{station}';

interface SpecCalculator {
  name: string;
  operation: string;
  /** The migration that ships this calculator; unset = migration 804 (the original set, never regenerated differently). */
  migration?: number;
  /** A later migration that ships this calculator again: it was added to the spec after migration 804 had been applied, so databases that ran the earlier 804 never received it. */
  reissue?: number;
  /**
   * A later migration replaces this calculator with the spec's next entry of the same name. The entry stays, unchanged, because an applied
   * migration (804) is generated from it and must never change; everything else reads only the current entry.
   */
  supersededBy?: number;
  description: string;
  machineClasses: string[];
  fields: SpecField[];
}

export interface MachiningCalculatorSpec {
  stations: Record<string, string>;
  calculators: SpecCalculator[];
  retire: string[];
}

/** The migration an entry shipped in: its own, a re-issue's, else 804 (every calculator without one is in 804). */
const shippedIn = (c: any): number => Number(c.migration ?? c.reissue ?? 804);

/** The entry of `name` that was current at migration `at`: shipped at or before it, superseded only after it. */
function versionShippedWith(entries: any[], name: string, at: number): any {
  return entries.find((e) => e.name === name && shippedIn(e) <= at && (e.supersededBy == null || Number(e.supersededBy) > at));
}

/**
 * The spec's calculators. By default only the current entry of each calculator: one a later migration replaced (supersededBy) is left
 * out. `includeSuperseded` keeps it, for generating the migration that shipped it (804), which must stay byte-identical once applied.
 */
export function loadMachiningCalculatorSpec(opts: { includeSuperseded?: boolean } = {}): MachiningCalculatorSpec {
  const raw = spec as any;
  const groups: Record<string, string[]> = { lathes: raw.lathes, mills: raw.mills };
  const entries = (raw.calculators as any[]).filter((c) => opts.includeSuperseded || !c.supersededBy);
  const byName = new Map<string, any>(entries.map((c: any) => [c.name, c]));
  const calculators: SpecCalculator[] = entries.map((c: any) => {
    const classes: string[] = Array.isArray(c.machineClasses)
      ? c.machineClasses
      : String(c.machineClasses).split('+').flatMap((g: string) => groups[g] ?? []);
    // An entry copies the version of the calculator it names that was current when it shipped (shipped no later, and not yet
    // superseded then), so the migration that shipped it never changes when that calculator is revised again. That version is looked
    // for among every entry, superseded ones too: the live copier of a since-revised calculator (Bulk Milling of Rough Milling 1031)
    // keeps the fields it shipped with, as the database does, not the revision's.
    const copied = (c.sameFieldsAs ? versionShippedWith(raw.calculators as any[], c.sameFieldsAs, shippedIn(c)) : undefined) ?? byName.get(c.sameFieldsAs);
    const fields: SpecField[] = c.fields ?? copied?.fields;
    if (!fields) throw new Error(`machining calculator "${c.name}" has no fields`);
    for (const cls of classes) {
      if (!raw.stations[cls]) throw new Error(`machining calculator "${c.name}": no catalog station for machine class "${cls}"`);
    }
    return { name: c.name, operation: c.operation, description: c.description, machineClasses: classes, fields, ...(c.migration ? { migration: c.migration } : {}), ...(c.reissue ? { reissue: c.reissue } : {}), ...(c.supersededBy ? { supersededBy: c.supersededBy } : {}) };
  });
  return { stations: raw.stations, calculators, retire: raw.retire };
}

/** A spec field as the calculator_fields row it becomes. */
export function specFieldToRow(f: SpecField, order: number): MachiningCalculatorField {
  return {
    field_name: f.name,
    display_label: f.unit ? `${f.name} (${f.unit})` : f.name,
    field_type: f.formula ? 'calculated' : 'number',
    default_value: f.formula ?? (f.default != null ? String(f.default) : null),
    unit: f.unit,
    display_order: order,
    data_source: f.source === 'lookup' ? 'machining_lookup' : null,
    source_table: f.table ?? null,
    source_field: f.column ?? null,
  };
}

/**
 * Where each field's default comes from (the spec's `note`), by calculator name then field name. The database rows have no column for it
 * (specFieldToRow writes none), so whoever loads a machining calculator lays these over its fields (withSpecNotes), for the step's source
 * and the calculator's table of defaults (calculatorField).
 */
export function specFieldNotes(s: MachiningCalculatorSpec = loadMachiningCalculatorSpec()): ReadonlyMap<string, ReadonlyMap<string, string>> {
  return new Map(s.calculators.map((c) => [c.name, new Map(c.fields.flatMap((f) => (f.note ? [[f.name, f.note] as const] : [])))]));
}

let notesCache: ReadonlyMap<string, ReadonlyMap<string, string>> | null = null;

/** A machining calculator's fields with the spec's note on each that has one (a calculator not in the spec: as they are). */
export function withSpecNotes<F extends MachiningCalculatorField>(calculatorName: string, fields: readonly F[]): F[] {
  notesCache ??= specFieldNotes();
  const notes = notesCache.get(calculatorName);
  return fields.map((f) => {
    const note = notes?.get(f.field_name);
    return note ? { ...f, note } : f;
  });
}

/** The spec as the per-operation calculator set the engine receives (ids are the spec names), each field with its note. */
export function specAsCalculators(s: MachiningCalculatorSpec = loadMachiningCalculatorSpec()): MachiningCalculators {
  return Object.fromEntries(s.calculators.flatMap((c) => {
    const def = { calculatorId: c.name, name: c.name, version: 1, fields: c.fields.map((f, i) => ({ ...specFieldToRow(f, i + 1), ...(f.note ? { note: f.note } : {}) })) };
    const operations = c.operation === STATION_OPERATION ? c.machineClasses.map((cls) => s.stations[cls]!) : [c.operation];
    return operations.map((op) => [op, def]);
  }));
}

/**
 * The inputs of a machining calculator read from the machine it runs on (its top spindle speed), by the calculator's name: the fields
 * the spec sources from the machine. The calculator_fields rows do not say so (a spec field becomes a plain number row, specFieldToRow),
 * so the Edit Process Cost dialog is told which fields to read for the machine chosen there.
 */
export function machineSourcedFields(calculatorName: string, s: MachiningCalculatorSpec = loadMachiningCalculatorSpec()): string[] {
  return s.calculators.find((c) => c.name === calculatorName)?.fields.filter((f) => f.source === 'machine').map((f) => f.name) ?? [];
}
