// Where a casting calculator input was read, for a value that is not a single variable, table row, record or CAD measurement: the part's
// batch (its costing inputs), the energy price (the location's electricity price, or the Cost Guide's), and a value the route worked out
// from others (the cavities that fit the flask, the trees a batch needs, ...), shown as the calculation it is, step by step. Each is the
// SourceRef the calculator dialog's eye opens; nothing here computes a cost.
import type { CalculationTraceStep, SourceRef } from '../../dto/cost-breakdown.dto';
import type { CalcSeed } from '../shared/calculators/reference-calculator';

const round = (v: number): number => (Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);

/** The part's batch: one of its costing inputs. */
export const BATCH_REF: SourceRef = { kind: 'costingInput', field: 'batchSize' };

/** A seed of the part's batch size. */
export const batchSeed = (batchSize: number, source = "The part's batch size"): CalcSeed => ({ value: batchSize, source, ref: BATCH_REF });

/** One input step of a calculation ref: a value and where it came from, with its own ref when it has one. */
export function inputStep(label: string, unit: string | null, value: number | string, source: string, ref?: SourceRef | null): CalculationTraceStep {
  return {
    fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'input', value: typeof value === 'number' ? round(value) : value, unit, source,
    ...(ref ? { ref } : {}),
  };
}

/** A seed's value as an input step of a calculation ref (its source and ref kept). */
export const seedStep = (label: string, unit: string | null, seed: CalcSeed): CalculationTraceStep => inputStep(label, unit, seed.value, seed.source, seed.ref);

/** The calculated step a calculation ref ends with: its formula over the steps before it, and the value it gave. */
export function resultStep(label: string, unit: string | null, value: number, formula: string): CalculationTraceStep {
  return { fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'calculated', value: round(value), unit, formula, stepType: 'physics' };
}

/** A value worked out from others, as the calculation the dialog shows step by step. */
export const calculationRef = (name: string, steps: CalculationTraceStep[]): SourceRef => ({ kind: 'calculation', name, evidence: null, steps });

/** A seed of a value the route worked out, opening that working. */
export const calculatedSeed = (value: number, source: string, name: string, steps: CalculationTraceStep[]): CalcSeed =>
  ({ value, source, ref: calculationRef(name, steps) });

/** The energy price a casting route charges, where it came from, and the ref that opens it (casting/sand/sand-cost.ts energyPrice). */
export interface EnergyPriceInput {
  energyPricePerKwh: number | null;
  energyPriceSource?: string | null;
  energyPriceRef?: SourceRef | null;
}

/**
 * The ref of a value set in the part's Cost Guide (its scenario, which has no viewer of its own): the entry it is, by its key, and what it
 * replaces. `instead` names the value the route would otherwise take.
 */
export function costGuideRef(name: string, unit: string | null, value: number, key: string, instead: string): SourceRef {
  return calculationRef(`${name}: the Cost Guide`, [
    inputStep(`${name} set in the Cost Guide`, unit, value, `The part's Cost Guide (${key})`),
    resultStep(name, unit, value, `The Cost Guide's value is used instead of ${instead}`),
  ]);
}

/** A seed of a value set in the part's Cost Guide (costGuideRef). */
export const costGuideSeed = (name: string, unit: string | null, value: number, key: string, instead: string, source?: string): CalcSeed =>
  ({ value, source: source ?? `${name} set in the Cost Guide`, ref: costGuideRef(name, unit, value, key, instead) });

/** The ref of an energy price set in the Cost Guide. */
export const costGuideEnergyRef = (usdPerKwh: number, key: string): SourceRef =>
  costGuideRef('Energy Price', 'USD/kWh', usdPerKwh, key, "the location's electricity price");

/**
 * A figure of the casting analysis with no faces of its own to light (a wall from the wall profile, a core from the trapped regions, the
 * part's box): how it was measured, as a step (with the faces it was measured over, when there are any).
 */
export function measuredRef(name: string, unit: string | null, value: number, how: string, ref?: SourceRef | null): SourceRef {
  return calculationRef(name, [inputStep(name, unit, value, how, ref)]);
}

/** A seed of a figure of the casting analysis (measuredRef). */
export const measuredSeed = (value: number, source: string, name: string, unit: string | null, how: string, ref?: SourceRef | null): CalcSeed =>
  ({ value, source, ref: measuredRef(name, unit, value, how, ref) });

/** The wall profile of the casting analysis: rays cast inward from every face of the part (cad-engine shared/casting_geometry.py). */
const WALL_PROFILE = 'CAD casting analysis: the wall thickness profile, rays cast inward from every face of the part (shared/casting_geometry.py wall_thickness_profile)';

/** A wall of the part from the analysis's wall profile: the faces it was sampled from are every face of the part. */
export const wallSeed = (value: number, which: 'thickest' | 'nominal', source: string): CalcSeed =>
  measuredSeed(value, source, which === 'thickest' ? 'Thickest wall' : 'Nominal wall', 'mm',
    `${WALL_PROFILE}: ${which === 'thickest' ? 'its thickest sample' : 'its nominal (most common) thickness'}`, { kind: 'cad', evidence: 'part_surface' });

/** The longest side of the part's bounding box. */
export const partLengthSeed = (value: number, source: string): CalcSeed =>
  measuredSeed(value, source, 'Part length', 'mm', "CAD: the longest side of the part's bounding box");

/**
 * The energy price seed of a casting calculator: the priced value with its ref (the location's electricity price row, or the Cost Guide
 * entry); with no price, 0, opening why (none set in the Cost Guide, none for the location): energy is then not charged.
 */
export function energySeed(e: EnergyPriceInput): CalcSeed {
  if (e.energyPricePerKwh != null) {
    return { value: e.energyPricePerKwh, source: e.energyPriceSource ?? 'energy price (USD/kWh)', ...(e.energyPriceRef ? { ref: e.energyPriceRef } : {}) };
  }
  return {
    value: 0, source: 'no energy price: none set in the Cost Guide and none for the location',
    ref: calculationRef('Energy price: none', [
      inputStep('Energy price set in the Cost Guide', 'USD/kWh', 'none', "The part's Cost Guide (energyPriceUsdPerKwh): not set"),
      inputStep('Electricity price of the location', 'USD/kWh', 'none', 'location_electricity_prices: no row for the location (or no exchange rate to USD)'),
      resultStep('Energy Price', 'USD/kWh', 0, 'No price: energy is not charged, and each line says so'),
    ]),
  };
}
