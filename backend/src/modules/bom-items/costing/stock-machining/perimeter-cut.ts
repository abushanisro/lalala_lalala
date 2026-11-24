// The cut round a plate part's outline of Perimeter Milling with Drop-off (stock/plate-roughing.ts), as one operation of the mill that makes
// the part: "Perimeter Milling", the reference catalog's operation on a part's Perimeter ("3 Axis Mill:Perimeter Milling//Perimeter"). It is
// timed by the stored calculator "Stock Machining - Perimeter Cut" (stock-machining-calculators.json, migration 1119): a slot as wide as the
// cutter through the plate, in passes by the keyway's slotting rule, each pass following the outline at the cutter's feed. Pure.
//
// Nothing of the rule is held here. The cutter and how it runs in the material are tblMillingFinishing's (the cutter the finishing passes
// use, seeded as they seed it: operation-sequencer.ts cutterRunSeeds). The depth of a pass and the spindle limit are read off the stored
// calculator of the keyway's slotting, "Machining - Obround Slot Milling" (migration 1118), so the two slotting cuts cannot disagree.
import { KEYWAY_MILLING, cutterRunSeeds, finishingTableSeed, type MillingFinishingRow, type OperationLine } from '../machining/operation/operation-sequencer';
import { runReferenceCalculator, type CalcSeed, type ReferenceCalculatorDef, type ReferenceCalculators } from '../shared/calculators/reference-calculator';

import type { MaterialClass } from '../machining/process/cost-machining-engine';

/** The catalog's operation of the cut, and the feature it acts on: the part's perimeter. */
export const PERIMETER_MILLING = 'Perimeter Milling';
export const PERIMETER_FEATURE = 'Perimeter';
export const PERIMETER_CUT_CALC = 'Stock Machining - Perimeter Cut';

/** The slotting rule of a solid end mill: the depth of a pass over the cutter's diameter. */
export interface SlottingRule {
  depthRatio: number;
}

/** Before a mill is chosen (the drop-off techniques compared), the cut is timed with no spindle limit; the mill's line times it on its own. */
const NO_MILL_YET: CalcSeed = { value: 1e12, source: 'No mill yet: the drop-off techniques are compared with no spindle limit; the mill line times the cut on its own spindle' };

const stated = (def: ReferenceCalculatorDef | undefined, field: string): number | null => {
  const value = Number(def?.fields.find((f) => f.field_name === field)?.default_value);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * The slotting rule as the keyway's stored calculator states it (its Slotting Depth Ratio); null when it is not on file. The spindle is the
 * mill's own (migration 1150): the cut is timed on the mill that makes it, not at a stated speed.
 */
export function slottingRuleOf(machiningCalculators: ReferenceCalculators | null | undefined): SlottingRule | null {
  const depthRatio = stated(machiningCalculators?.[KEYWAY_MILLING], 'Slotting Depth Ratio');
  return depthRatio != null ? { depthRatio } : null;
}

/** What the mill cuts the outline with: the material's standard end mill and how it runs, and the slotting rule. */
export interface PerimeterCutter {
  matClass: MaterialClass;
  /** The material's tblMillingFinishing row; null when it lists none. */
  finishing: MillingFinishingRow | null;
  /** The part's machinability over the baseline (the factor every milling calculator's cutting speed carries). */
  machinabilityFactor: number;
  /** Null when "Machining - Obround Slot Milling" is not in the database (migration 1118). */
  slotting: SlottingRule | null;
  /** Whether the part's milling operations are sequenced (it has a feature graph): the cut is one more operation of that sequence. */
  sequenced: boolean;
}

/** Why the cut cannot be milled or timed; null when it can. */
export function perimeterCutterMissing(cutter: PerimeterCutter, calculators: Readonly<Record<string, ReferenceCalculatorDef>>): string | null {
  if (!cutter.finishing) return `tblMillingFinishing lists no cutter for ${cutter.matClass}: the perimeter cut has no cutter to be sized and timed by`;
  if (!cutter.slotting) return 'the slotting rule of the cut is not in the database (Machining - Obround Slot Milling, migration 1118)';
  if (!(PERIMETER_CUT_CALC in calculators)) return `the calculator of the cut is not in the database (${PERIMETER_CUT_CALC}, migration 1119)`;
  if (!cutter.sequenced) return 'the part\'s analysis holds no feature graph, so its milling operations are not sequenced: press Refresh analysis';
  return null;
}

/**
 * The perimeter cut as an operation of the mill's sequence, timed by its calculator: the outline's length, the plate's thickness, the
 * cutter and the slotting rule in; the calculator adds the cutter's diameter of lead to each pass.
 */
export function perimeterCutOperation(input: {
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  outlinePerimeterMm: number;
  plateThicknessMm: number;
  finishing: MillingFinishingRow;
  matClass: MaterialClass;
  machinabilityFactor: number;
  slotting: SlottingRule;
}): OperationLine {
  const seeds: Record<string, CalcSeed> = {
    'Outline Perimeter': { value: input.outlinePerimeterMm, source: 'CAD: the length of the part\'s outline seen through the plate (the analysis\'s plate outline)' },
    'Plate Thickness': { value: input.plateThicknessMm, source: 'Stock Machining stock: the plate\'s thickness (tblPreferredSizes)' },
    'Cutter Diameter': finishingTableSeed(input.matClass, input.finishing.toolDiameterMm, 'ToolDiameterMm'),
    ...cutterRunSeeds(input.finishing, input.matClass, input.machinabilityFactor),
    'Slotting Depth Ratio': { value: input.slotting.depthRatio, source: 'Machining - Obround Slot Milling: Slotting Depth Ratio (the stored calculator\'s value)' },
  };
  const run = runReferenceCalculator(input.calculators, PERIMETER_CUT_CALC, { ...seeds, 'Max Spindle Speed': NO_MILL_YET });
  return {
    name: PERIMETER_MILLING, timeSec: run.sec ?? 0, trace: run.trace, source: 'stock', cadFeatureType: PERIMETER_FEATURE, count: 1,
    // The mill's line times it again on its machine, its spindle capped at the machine's own top speed (timeOperations).
    plan: [{ operation: PERIMETER_CUT_CALC, seeds, calculators: input.calculators }],
    ...(run.calculatorId ? { calculator: { id: run.calculatorId, version: run.calculatorVersion, lookups: run.lookups } } : {}),
    ...(run.missing.length > 0 ? { missing: run.missing.join('; ') } : {}),
  };
}
