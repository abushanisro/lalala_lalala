// The checks every family's "every input has a source" guard runs on the lines its engines produce: an input step with no SourceRef has no
// eye, and a ref that opens nothing is an eye that opens an empty panel. Both are listed as "process | field | source" so a failing guard
// names exactly what to fix.
import type { CalculationTraceStep, ProcessLineCost, SourceRef } from '../../../../modules/bom-items/dto/cost-breakdown.dto';
import {
  COSTING_TABLES, COSTING_TABLES_DOMAIN, PLASTIC_REFERENCE_PACKAGE_DOMAIN, PLASTIC_REFERENCE_PACKAGE_FILES,
} from '../../../../modules/bom-items/costing/shared/served-reference-tables';

type Line = Pick<ProcessLineCost, 'process' | 'calculationTrace'>;

/** Every input step of these lines that carries no ref: "process | field | source". */
export function inputsWithoutRef(lines: readonly Line[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const s of (l.calculationTrace ?? []) as CalculationTraceStep[]) {
      if (s.kind !== 'input' || s.ref) continue;
      out.push(`${l.process} | ${s.fieldName} | ${s.source ?? ''}`);
    }
  }
  return [...new Set(out)];
}

/**
 * Every ref that opens nothing (no eye may open an empty panel): a features or faces ref with none to light, a calculation with no step, a
 * calculator's defaults table without the field, a lookup with no table or column (or a served table the endpoint does not serve), a
 * machine or material with no record. Each step of a calculation is checked the same way.
 */
export function refsOpeningNothing(lines: readonly Line[]): string[] {
  const out: string[] = [];
  const check = (where: string, ref: SourceRef): void => {
    const bad = (why: string) => out.push(`${where}: ${ref.kind} ${why}`);
    if (ref.kind === 'features' && ref.features.length === 0) bad('lights no feature');
    if (ref.kind === 'faces' && ref.faceIds.length === 0) bad('lights no face');
    if (ref.kind === 'calculation') {
      if (ref.steps.length === 0) bad('has no step');
      for (const st of ref.steps) if (st.ref) check(`${where} > ${st.fieldName}`, st.ref);
    }
    if (ref.kind === 'calculatorField' && !ref.defaults.some((d) => d.field === ref.field)) bad(`does not list ${ref.field}`);
    if ((ref.kind === 'lookup' || ref.kind === 'smTable') && (!ref.table || !ref.column)) bad('names no table or column');
    if (ref.kind === 'lookup' && ref.domain === PLASTIC_REFERENCE_PACKAGE_DOMAIN && !(PLASTIC_REFERENCE_PACKAGE_FILES as readonly string[]).includes(ref.table)) bad(`names no served file (${ref.table})`);
    if (ref.kind === 'lookup' && ref.domain === COSTING_TABLES_DOMAIN && !(COSTING_TABLES as readonly string[]).includes(ref.table)) bad(`names no served table (${ref.table})`);
    if (ref.kind === 'lookup' && !ref.domain) bad('names no domain');
    if (ref.kind === 'machine' && (!ref.machineId || !ref.column)) bad('names no machine record or column');
    if (ref.kind === 'material' && (!ref.materialId || !ref.column)) bad('names no material record or column');
    if (ref.kind === 'variable' && (!ref.domain || !ref.name)) bad('names no variable');
  };
  for (const l of lines) {
    for (const st of (l.calculationTrace ?? []) as CalculationTraceStep[]) if (st.kind === 'input' && st.ref) check(`${l.process} | ${st.fieldName}`, st.ref);
  }
  return [...new Set(out)];
}

/**
 * A calculator run of a route (its material, its stock, a consumable), as the cost summary shows it under calculatorRuns: checked like a line,
 * named by its key. Runs that are null (not made) are left out.
 */
export function runsAsLines(runs: Readonly<Record<string, { trace: readonly CalculationTraceStep[] } | null | undefined>>): Line[] {
  return Object.entries(runs).flatMap(([key, run]) => (run ? [{ process: `calculatorRuns.${key}`, calculationTrace: [...run.trace] }] : []));
}

/** Both checks at once, for an `expect(...).toEqual({ withoutRef: [], openingNothing: [] })`. */
export function sourceGaps(lines: readonly Line[]): { withoutRef: string[]; openingNothing: string[] } {
  return { withoutRef: inputsWithoutRef(lines), openingNothing: refsOpeningNothing(lines) };
}
