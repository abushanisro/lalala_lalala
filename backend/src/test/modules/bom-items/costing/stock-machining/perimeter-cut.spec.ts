// The cut round a plate part's outline of Perimeter Milling with Drop-off (perimeter-cut.ts), timed by the stored calculator "Stock Machining
// - Perimeter Cut" (migration 1119):
//
//   Spindle Speed = min(Max Spindle Speed, Cutting Speed * 1000 / (pi * Cutter Diameter))                 [rpm]
//   Feed Rate     = Spindle Speed * Teeth * Feed per Tooth per Diameter * Cutter Diameter                 [mm/min]
//   Passes        = ceil(Plate Thickness / (Slotting Depth Ratio * Cutter Diameter))
//   Path per Pass = Outline Perimeter + Cutter Diameter                                                   [mm]
//   Cycle Time    = Passes * Path per Pass / Feed Rate * 60                                               [s]
//
// The cutter is the material class's tblMillingFinishing row (aluminium: Ø10, 3 teeth, 183 m/min, 0.008 per diameter; mild steel: Ø10, 4
// teeth, 76 m/min, 0.008). Max Spindle Speed 10 000 rpm and Slotting Depth Ratio 0.2 are read off the keyway's stored calculator,
// "Machining - Obround Slot Milling". Every expected number is worked out by hand from these.
import { specAsCalculators } from '../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildOperationSequence, type MillingFinishingRow, type SequenceOptions } from '../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { isReferenceOperation } from '../../../../../modules/bom-items/costing/shared/reference-features.generated';
import { loadStockMachiningCalculatorSpec, stockMachiningCalculatorsByName } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculator-spec';
import {
  PERIMETER_CUT_CALC, PERIMETER_FEATURE, PERIMETER_MILLING, perimeterCutOperation, perimeterCutterMissing, slottingRuleOf, type PerimeterCutter,
} from '../../../../../modules/bom-items/costing/stock-machining/perimeter-cut';

const MACHINING = specAsCalculators();
const STOCK_CALCS = stockMachiningCalculatorsByName();
const SLOTTING = slottingRuleOf(MACHINING)!;
const ALUMINIUM: MillingFinishingRow = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
const MILD_STEEL: MillingFinishingRow = { toolDiameterMm: 10, teeth: 4, cuttingSpeedMPerMin: 76, feedPerToothPerDiameter: 0.008 };

// STIFFNER 2's outline (397.81 mm) through a 1/2 in (12.7 mm) plate.
const cutOf = (over: Partial<Parameters<typeof perimeterCutOperation>[0]> = {}) => perimeterCutOperation({
  calculators: STOCK_CALCS, outlinePerimeterMm: 397.81, plateThicknessMm: 12.7, finishing: ALUMINIUM, matClass: 'aluminum', machinabilityFactor: 1, slotting: SLOTTING, ...over,
});
const step = (op: ReturnType<typeof cutOf>, field: string) => op.trace!.find((s) => s.fieldName === field);

describe('the perimeter cut: the catalog\'s operation and its calculator', () => {
  it('is Perimeter Milling on the part\'s Perimeter, a catalog operation of the mills', () => {
    expect(PERIMETER_MILLING).toBe('Perimeter Milling');
    expect(isReferenceOperation('machining', PERIMETER_FEATURE, PERIMETER_MILLING)).toBe(true);
  });

  it('is a helper calculator of the Stock Machining spec, shipped by migration 1119, with every input sourced', () => {
    const calc = loadStockMachiningCalculatorSpec().calculators.find((c) => c.name === PERIMETER_CUT_CALC)!;
    expect(calc.helper).toBe(true);
    expect(calc.operations).toEqual([]);
    expect(calc.migration).toBe(1119);
    expect(calc.fields.filter((f) => !f.formula).every((f) => f.source && 'engine' in f.source)).toBe(true);
    expect(calc.fields.filter((f) => f.formula).map((f) => f.name)).toEqual(['Spindle Speed', 'Feed Rate', 'Passes', 'Path per Pass', 'Cycle Time']);
  });

  it('reads the slotting rule off the keyway\'s stored calculator, and has none without it', () => {
    expect(SLOTTING).toEqual({ depthRatio: 0.2, maxSpindleRpm: 10000 });
    expect(slottingRuleOf({})).toBeNull();
    expect(slottingRuleOf(null)).toBeNull();
    const { 'Obround Slot Milling': keyway, ...rest } = MACHINING;
    expect(slottingRuleOf(rest)).toBeNull();
    // A keyway calculator that states no depth ratio gives no rule: nothing is assumed in its place.
    expect(slottingRuleOf({ ...rest, 'Obround Slot Milling': { ...keyway!, fields: keyway!.fields.filter((f) => f.field_name !== 'Slotting Depth Ratio') } })).toBeNull();
  });
});

describe('Stock Machining - Perimeter Cut: the calculator, by hand', () => {
  it('aluminium, 12.7 mm plate: 5825 rpm, 1398 mm/min, 7 passes of 407.81 mm = 122.52 s', () => {
    // 183 000 / (pi x 10) = 5825.07 rpm (under the 10 000 limit). Feed 5825.07 x 3 x 0.008 x 10 = 1398.017 mm/min.
    // Passes ceil(12.7 / (0.2 x 10)) = ceil(6.35) = 7. Path 397.81 + 10 = 407.81 mm. 7 x 407.81 / 1398.017 x 60 = 122.516 s.
    const op = cutOf();
    expect(step(op, 'Spindle Speed')!.value).toBeCloseTo(5825.07, 1);
    expect(step(op, 'Feed Rate')!.value).toBeCloseTo(1398.017, 2);
    expect(step(op, 'Passes')!.value).toBe(7);
    expect(step(op, 'Path per Pass')!.value).toBeCloseTo(407.81, 6);
    expect(op.timeSec).toBeCloseTo((7 * 407.81) / ((183000 / (Math.PI * 10)) * 3 * 0.008 * 10) * 60, 6);
    expect(op.timeSec).toBeCloseTo(122.516, 2);
    expect(op.missing).toBeUndefined();
  });

  it('mild steel: 2419 rpm, 774 mm/min = 221.26 s', () => {
    // 76 000 / (pi x 10) = 2419.16 rpm. Feed 2419.16 x 4 x 0.008 x 10 = 774.13 mm/min. 7 x 407.81 / 774.13 x 60 = 221.26 s.
    const op = cutOf({ finishing: MILD_STEEL, matClass: 'mild_steel' });
    expect(step(op, 'Feed Rate')!.value).toBeCloseTo(774.13, 1);
    expect(op.timeSec).toBeCloseTo(221.26, 1);
  });

  it('a free-machining aluminium (machinability 150: factor 2) runs at the spindle limit: 2400 mm/min = 71.37 s', () => {
    // 2 x 183 000 / (pi x 10) = 11 650 rpm, held to 10 000. Feed 10 000 x 0.24 = 2400 mm/min. 7 x 407.81 / 2400 x 60 = 71.367 s.
    const op = cutOf({ machinabilityFactor: 2 });
    expect(step(op, 'Spindle Speed')!.value).toBe(10000);
    expect(op.timeSec).toBeCloseTo(71.367, 2);
  });

  it('takes one pass more for each slotting depth of plate, and none more for an exact number of them', () => {
    // 0.2 x 10 = 2 mm a pass: 12 mm is 6 passes exactly, 12.01 mm is 7, 25.4 mm is ceil(12.7) = 13.
    expect(step(cutOf({ plateThicknessMm: 12 }), 'Passes')!.value).toBe(6);
    expect(step(cutOf({ plateThicknessMm: 12.01 }), 'Passes')!.value).toBe(7);
    expect(step(cutOf({ plateThicknessMm: 25.4 }), 'Passes')!.value).toBe(13);
    // 13 passes of 407.81 mm at 1398.017 mm/min: 227.53 s.
    expect(cutOf({ plateThicknessMm: 25.4 }).timeSec).toBeCloseTo(227.53, 1);
  });

  it('says where each input was read', () => {
    const op = cutOf();
    expect(step(op, 'Outline Perimeter')!.source).toContain('plate outline');
    expect(step(op, 'Plate Thickness')!.source).toContain('the plate\'s thickness');
    expect(step(op, 'Cutter Diameter')!.source).toBe('tblMillingFinishing: aluminum ToolDiameterMm');
    expect(step(op, 'Cutting Speed')!.source).toBe('tblMillingFinishing: aluminum CuttingSpeedMPerMin 183 m/min x machinability factor 1');
    expect(step(op, 'Slotting Depth Ratio')!.source).toContain('Machining - Obround Slot Milling');
    expect(step(op, 'Max Spindle Speed')!.source).toContain('Machining - Obround Slot Milling');
    expect(op.calculator?.id).toBe(PERIMETER_CUT_CALC);
  });

  it('is an operation on the stock, on the part\'s perimeter, never an estimate when its calculator is missing', () => {
    const op = cutOf();
    expect(op).toMatchObject({ name: 'Perimeter Milling', source: 'stock', cadFeatureType: 'Perimeter', count: 1 });
    const { [PERIMETER_CUT_CALC]: _cut, ...without } = STOCK_CALCS;
    const gap = cutOf({ calculators: without });
    expect(gap.timeSec).toBe(0);
    expect(gap.missing).toContain(PERIMETER_CUT_CALC);
  });
});

describe('what the perimeter cut needs', () => {
  const cutter: PerimeterCutter = { matClass: 'aluminum', finishing: ALUMINIUM, machinabilityFactor: 1, slotting: SLOTTING, sequenced: true };

  it('is there when the cutter, the slotting rule, the calculator and the part\'s sequence are', () => {
    expect(perimeterCutterMissing(cutter, STOCK_CALCS)).toBeNull();
  });

  it('names what is missing', () => {
    const { [PERIMETER_CUT_CALC]: _cut, ...without } = STOCK_CALCS;
    expect(perimeterCutterMissing({ ...cutter, finishing: null }, STOCK_CALCS)).toContain('tblMillingFinishing lists no cutter for aluminum');
    expect(perimeterCutterMissing({ ...cutter, slotting: null }, STOCK_CALCS)).toContain('Machining - Obround Slot Milling, migration 1118');
    expect(perimeterCutterMissing(cutter, without)).toContain('Stock Machining - Perimeter Cut, migration 1119');
    expect(perimeterCutterMissing({ ...cutter, sequenced: false }, STOCK_CALCS)).toContain('no feature graph');
  });
});

describe('the perimeter cut in the mill\'s sequence', () => {
  const features = [{ id: 'PlanarFace-default_c1', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ area_mm2: 1000 }] }];
  const sequence = (stockOps: SequenceOptions['stockOps']) =>
    buildOperationSequence(features, { matClass: 'aluminum', machinabilityFactor: 1, materialGrade: 'Aluminum, ANSI 6061', calculators: MACHINING, removalRateMm3PerMin: 60000, finishing: ALUMINIUM, stockOps });

  it('takes its place among the operations, with its own time and steps', () => {
    const op = cutOf();
    const ops = sequence([op]);
    expect(ops.map((o) => o.name)).toEqual(['Fine Finish Milling', 'Perimeter Milling', 'Deburr']);
    expect(ops.find((o) => o.name === 'Perimeter Milling')).toBe(op);
  });

  it('is absent from a sequence with no stock operation: the sequence is what it was', () => {
    expect(sequence([])).toEqual(sequence(undefined));
    expect(sequence(undefined).map((o) => o.name)).toEqual(['Fine Finish Milling', 'Deburr']);
  });
});
