import type { CalculationTraceStep, SourceRef } from '../../../dto/cost-breakdown.dto';
import type { CadEvidenceKey } from '../cad-evidence';
import type { CalcSeed } from './reference-calculator';

/**
 * Where a calculator input's value came from (SourceRef), for the engines built on the shared calculator runner: the part's batch, a
 * calculator run the value is the result of, or a value the engine worked out from other values, shown step by step. Each is attached where
 * the seed is built, so the calculator dialog's eye beside the input opens it. Pure.
 */

/** The part's batch (its resolved costing inputs). */
export const BATCH_SIZE_REF: SourceRef = { kind: 'costingInput', field: 'batchSize' };

/** The batch as a seed: the part's costing inputs are where it was read. */
export const batchSizeSeed = (batchSize: number, source = 'batch size'): CalcSeed => ({ value: batchSize, source, ref: BATCH_SIZE_REF });

const round = (v: number): number => (Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);

/** An input step of a calculation ref: a value and where it came from, with its own ref when it has one. */
export function inputStep(label: string, unit: string | null, value: number | string, source: string, ref?: SourceRef): CalculationTraceStep {
  return {
    fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'input', value: typeof value === 'number' ? round(value) : value, unit, source,
    ...(ref ? { ref } : {}),
  };
}

/** An input step of a calculation ref, from the seed it was read as (its value, source and ref). */
export function seedStep(label: string, unit: string | null, seed: CalcSeed): CalculationTraceStep {
  return inputStep(label, unit, seed.value, seed.source, seed.ref);
}

/** The calculated step a calculation ref ends with: its formula over the steps before it and the value it gave. */
export function resultStep(label: string, unit: string | null, value: number, formula: string): CalculationTraceStep {
  return { fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'calculated', value: round(value), unit, formula, stepType: 'physics' };
}

/** A value worked out from other values (each with its own source), as the calculation the dialog shows step by step. */
export function calculationRef(name: string, steps: CalculationTraceStep[], evidence: CadEvidenceKey | null = null): SourceRef {
  return { kind: 'calculation', name, evidence, steps };
}

/** A seed worked out from other values: its value and source, and the calculation that gave it. */
export function derivedSeed(value: number, source: string, name: string, steps: CalculationTraceStep[], evidence: CadEvidenceKey | null = null): CalcSeed {
  return { value, source, ref: calculationRef(name, steps, evidence) };
}

/** The result of a calculator run (its trace, every input with its own source), as the calculation an input taken from it opens. */
export function runRef(name: string, run: { trace: readonly CalculationTraceStep[] } | null | undefined): SourceRef | undefined {
  return run && run.trace.length > 0 ? calculationRef(name, [...run.trace]) : undefined;
}

/** A seed with its ref, when it has one (a seed whose source is not known stays as it was). */
export function withSeedRef(seed: CalcSeed, ref: SourceRef | undefined): CalcSeed {
  return ref ? { ...seed, ref } : seed;
}
