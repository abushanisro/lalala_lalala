// A mill removes the stock around the part. The operations the sequencer plans act on the part's features (a pocket, a hole, a face), so
// between the piece the mill starts from and the part nothing was milled away: STIFFNER 2, a 15 208 mm^3 part from a 105 613 mm^3 piece of
// bar, was costed 32 s of roughing for its one pocket and not a second for the other 65 638 mm^3.
//
// The plan of a milled route now has one more operation, "Bulk Milling" of the stock excess (stock-excess.ts):
//
//   stock excess = piece volume - part volume - volume the part's features remove - volume faced off the piece
//
// timed by the stored calculator "Machining - Bulk Milling" (the fields of Rough Milling):
//
//   Cycle Time = (Removed Volume * 0.9 / Removal Rate + Removed Volume * 0.1 / (Removal Rate * 0.4)) * 60        [s]
//
// (Roughing Share 0.9 since 1158: Otsuka et al. 1997, primary roughing "cut out 90% of the stock"), which for aluminium (60 000 mm^3/min,
// tblMillingRemovalRate) is Removed Volume * 1.15 / 1000 seconds. Every expected number below is
// worked out by hand from these.
import { BomItemCostingService } from '../../../../../../modules/bom-items/bom-item-costing.service';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildOperationSequence, type MillingFinishingRow, type OperationLine } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { featureRemovedVolumeMm3, stockExcess, type StockExcess } from '../../../../../../modules/bom-items/costing/machining/operation/stock-excess';
import {
  computeMillingCostSummary,
  computeTurningCostSummary,
  NO_STOCK_WARNING,
  type MachineClassId,
  type MachiningCostInput,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { realPartoffTable } from '../real-reference-tables';

import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { FeatureOp } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { workbookFixture } from '../workbook-fixture';
import { timeOperations } from '../../../../../../modules/bom-items/costing/machining/operation/time-operations';

const CALCS = specAsCalculators();
const ALUMINIUM: MillingFinishingRow = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
// The calculator's own value for a field whose source the spec does not state yet: said so (calculatorField's table reads "not yet sourced").

// An aluminium part from an 80 x 50 x 25 mm piece (100 000 mm^3). The part fills a 76 x 46 x 21 box (73 416 mm^3) less its features:
// two pockets (3000 + 1500 mm^3) and four 6 mm holes 10 mm deep (4 x 282.74 = 1130.96 mm^3), 5630.96 mm^3 in all. Part 67 785.04 mm^3.
const POCKETS = {
  id: 'PocketV2-default_c2', feature_type: 'PocketV2', variant: 'default',
  occurrences: [{ extents_mm: [30, 20, 0], depth_mm: 5, material_removed_mm3: 3000 }, { extents_mm: [30, 10, 0], depth_mm: 5, material_removed_mm3: 1500 }],
};
const HOLES = {
  id: 'SimpleHole-through_d6.0_c4', feature_type: 'SimpleHole', variant: 'through', diameter_mm: 6,
  occurrences: Array.from({ length: 4 }, () => ({ depth_mm: 10, material_removed_mm3: 282.74 })),
};
const FACE = { id: 'PlanarFace-default_c1', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ area_mm2: 2000, material_removed_mm3: 0 }] };
const FEATURES = [POCKETS, HOLES, FACE];
const PIECE_MM3 = 80 * 50 * 25;
const PART_MM3 = 67785.04;
// Stock around the part: 100 000 - 67 785.04 - 5630.96 = 26 584 mm^3 (the piece less the part's 73 416 mm^3 box).
const AROUND = stockExcess({ pieceMm3: PIECE_MM3, partMm3: PART_MM3, featureRemovedMm3: featureRemovedVolumeMm3(FEATURES) });
// 26 584 x 1.15 / 1000 = 30.5716 s.
const BULK_SEC = 30.5716;

const sequence = (features: unknown[] | null, stockAround: StockExcess | null, removalRate: number | null = 60000, machinabilityFactor = 1.0) =>
  buildOperationSequence(features, { matClass: 'aluminum', machinabilityFactor, materialGrade: 'Aluminum, ANSI 6061', workbook: workbookFixture(), calculators: CALCS, removalRateMm3PerMin: removalRate, finishing: ALUMINIUM, stockAround });
const named = (ops: OperationLine[], name: string) => ops.filter((o) => o.name === name);

describe('the sequencer mills away the stock around the part', () => {
  it('the fixture\'s stock excess is 26 584 mm^3', () => {
    expect(AROUND.featureRemovedMm3).toBeCloseTo(5630.96, 6);
    expect(AROUND.excessMm3).toBeCloseTo(26584, 6);
    expect(AROUND.excessMm3).toBeCloseTo(PIECE_MM3 - 76 * 46 * 21, 6);
  });

  it('as one Bulk Milling operation before the features, timed by the stored calculator on that volume at the material\'s removal rate', () => {
    const ops = sequence(FEATURES, AROUND);
    expect(ops[0]!.name).toBe('Bulk Milling');
    expect(ops[ops.length - 1]!.name).toBe('Deburr');
    const bulk = named(ops, 'Bulk Milling');
    expect(bulk).toHaveLength(1);
    const [op] = bulk;
    // It is on no one feature: the row has none to light.
    expect(op).toMatchObject({ source: 'fixed' });
    expect(op!.cadFeatureType).toBeUndefined();
    expect(op!.featureIds).toBeUndefined();
    expect(op!.missing).toBeUndefined();
    expect(op!.timeSec).toBeCloseTo(BULK_SEC, 6);
    expect(op!.timeSec).toBeCloseTo((26584 * 0.9 / 60000 + 26584 * 0.1 / (60000 * 0.4)) * 60, 6);
    expect(op!.calculator).toMatchObject({ id: 'Machining - Bulk Milling' });
    expect(op!.trace!.filter((s) => s.kind === 'input').map((s) => [s.fieldName, s.value, s.source])).toEqual([
      ['Removed Volume', 26584, 'Stock around the part: the piece 100000 mm^3 less the part 67785.04 mm^3 and the 5630.96 mm^3 its features remove'],
      ['Material Removal Rate', 60000, 'tblMillingRemovalRate: aluminum 60000 mm^3/min x machinability factor 1'],
      // Each default states its source (1158): a closest published basis, or that none was found.
      ['Roughing Share', 0.9, expect.stringMatching(/^Closest published basis: Otsuka et al\., JSAE 1997/)],
      ['Finishing Rate Factor', 0.4, expect.stringMatching(/^No published source found/)],
    ]);
    expect(op!.calculator!.lookups).toEqual({ 'Material Removal Rate': { table: 'tblMillingRemovalRate', row: { MaterialClass: 'aluminum' } } });
  });

  it('changes none of the operations on the features: they are what they are without it', () => {
    const without = sequence(FEATURES, null);
    expect(named(without, 'Bulk Milling')).toEqual([]);
    expect(sequence(FEATURES, AROUND).filter((o) => o.name !== 'Bulk Milling')).toEqual(without);
    // The pockets are roughed by their own runs of the workbook's End Milling sheet, one per pocket size, not on their volume.
    expect(named(without, 'Rough Milling').map((o) => [o.plan?.[0]?.operation, o.count])).toEqual([['Rough Milling', 1], ['Rough Milling', 1]]);
  });

  it('what Facing takes off the piece\'s top and bottom is faced, and only the rest is bulk milled', () => {
    // The 80 x 50 x 25 piece round the 76 x 46 x 21 part: Facing takes 80 x 50 x (25 - 21) = 16 000 mm^3 off its top and bottom (2 mm
    // each), Bulk Milling the other 26 584 - 16 000 = 10 584 mm^3; x 1.15 / 1000 = 12.1716 s.
    const facing = { faces: 2, lengthMm: 80, widthMm: 50, depthMm: 2, volumeMm3: 16000, basis: 'the 80 x 50 x 25 mm test piece' };
    const faced = stockExcess({ pieceMm3: PIECE_MM3, partMm3: PART_MM3, featureRemovedMm3: featureRemovedVolumeMm3(FEATURES), facedMm3: facing.volumeMm3 });
    expect(faced.excessMm3).toBeCloseTo(10584, 6);
    const ops = buildOperationSequence(FEATURES, {
      matClass: 'aluminum', machinabilityFactor: 1, materialGrade: 'Aluminum, ANSI 6061', workbook: workbookFixture(), calculators: CALCS, removalRateMm3PerMin: 60000,
      finishing: ALUMINIUM, stockAround: faced, facing,
    });
    expect(ops.slice(0, 2).map((o) => o.name)).toEqual(['Facing', 'Bulk Milling']);
    expect(named(ops, 'Bulk Milling')[0]!.timeSec).toBeCloseTo(12.1716, 6);
    expect(named(ops, 'Facing')[0]!.plan).toEqual([expect.objectContaining({ operation: 'Facing' })]);
    // The caption names every volume the value is worked out from, so it adds up: 100 000 - 67 785.04 - 16 000 - 5 630.96 = 10 584.
    expect(named(ops, 'Bulk Milling')[0]!.trace!.find((s) => s.fieldName === 'Removed Volume')).toMatchObject({
      value: 10584,
      source: 'Stock around the part: the piece 100000 mm^3 less the part 67785.04 mm^3, the 16000 mm^3 Facing takes off the piece and the 5630.96 mm^3 its features remove',
    });
  });

  it('the removal rate carries the material\'s machinability, as the roughing of a pocket does', () => {
    // Twice the baseline machinability: 120 000 mm^3/min, 26 584 x 1.15 / 2000 = 15.2858 s.
    const [op] = named(sequence(FEATURES, AROUND, 60000, 2.0), 'Bulk Milling');
    expect(op!.trace!.find((s) => s.fieldName === 'Material Removal Rate')).toMatchObject({ value: 120000 });
    expect(op!.timeSec).toBeCloseTo(15.2858, 6);
  });

  it('a part with no stock chosen, or with nothing left around it, gets no Bulk Milling', () => {
    expect(named(sequence(FEATURES, null), 'Bulk Milling')).toEqual([]);
    // The part and its features account for the whole piece.
    const none = stockExcess({ pieceMm3: PART_MM3 + AROUND.featureRemovedMm3, partMm3: PART_MM3, featureRemovedMm3: AROUND.featureRemovedMm3 });
    expect(none).toMatchObject({ excessMm3: 0, inconsistent: false });
    expect(named(sequence(FEATURES, none), 'Bulk Milling')).toEqual([]);
    // Features stated to remove more than the piece holds: never a negative volume to mill.
    const over = stockExcess({ pieceMm3: 70000, partMm3: PART_MM3, featureRemovedMm3: AROUND.featureRemovedMm3 });
    expect(over).toMatchObject({ excessMm3: 0, inconsistent: true });
    expect(named(sequence(FEATURES, over), 'Bulk Milling')).toEqual([]);
  });

  it('with no removal rate on file for the material it is a named gap, never an estimate', () => {
    const [op] = named(sequence(FEATURES, AROUND, null), 'Bulk Milling');
    expect(op!.timeSec).toBe(0);
    expect(op!.missing).toBe('Bulk Milling: Material Removal Rate');
  });

  it('a part with no feature graph has no sequence at all: the milled engine bulk mills its whole stock-to-part volume instead', () => {
    expect(sequence(null, AROUND)).toEqual([]);
    expect(sequence([], AROUND)).toEqual([]);
  });

  it('a turned diameter costed on a mill is milled out of the stock around the part, once: its own cylinder is not milled', () => {
    // The ring states its cylinder (900 mm^3), which is the part's own material: nothing is taken off the stock for it, and no operation
    // mills it. The stock around the part is the whole 3000 - 1600 = 1400 mm^3; x 1.15 / 1000 = 1.61 s (turned-diameter-on-a-mill.spec.ts).
    const ring = { id: 'Ring-outer_diameter_d14.0_c1', feature_type: 'Ring', variant: 'outer_diameter', diameter_mm: 14, occurrences: [{ depth_mm: 5.85, material_removed_mm3: 900 }] };
    const around = stockExcess({ pieceMm3: 3000, partMm3: 1600, featureRemovedMm3: featureRemovedVolumeMm3([ring]) });
    expect(around.excessMm3).toBe(1400);
    const bulk = named(sequence([ring], around), 'Bulk Milling');
    expect(bulk.map((o) => [o.source, o.featureIds, Math.round(o.timeSec * 1e6) / 1e6])).toEqual([['fixed', undefined, 1.61]]);
  });
});

// ── The mill line ────────────────────────────────────────────────────────────

const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);
const PIECE = { form: 'rectangular_bar', sizeLabel: '80 x 25 mm rectangular bar', billetVolMm3: PIECE_MM3, utilizationPct: null };

/** The fixture part on a 3-axis mill at 900 per hour, costed on these sequenced operations from this stock (null: no stock is chosen). */
function milled(featureOps: OperationLine[] | undefined, blankResult: MachiningCostInput['blankResult'] | null = PIECE) {
  const input: MachiningCostInput = {
    volume: PART_MM3, surfaceArea: 15000, maxLength: 76, maxWidth: 46, maxHeight: 21,
    holeCount: 0, holeGroups: [], pocketCount: 2,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 100, family: 'milled', finishedWeightKg: 0.183,
    // The mill's spindle limit and rapid traverse rate (migrations 1136, 1141), and the machining variables' rapid transfer factor.
    mhrRate: rate(900, { machineClass: '3_axis_mill', setupTimeHr: 0.5, maxSpindleRpm: 8000, rapidTraverseMmPerMin: 30000 }), rapidTransferDistanceFactor: 0.5,
    tappingRate: rate(900, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null,
    machiningCalculators: CALCS,
    millingRemovalRateMm3PerMin: 60000,
    ...(featureOps ? { featureOps } : {}),
    ...(blankResult ? { blankResult } : {}),
  };
  return computeMillingCostSummary(input, '3_axis_mill' as MachineClassId);
}
const millLineOf = (cost: ReturnType<typeof milled>) => cost.processLines.find((l) => l.process === '3 Axis Mill')!;

describe('on the mill line, the Bulk Milling of the stock around the part', () => {
  const line = millLineOf(milled(sequence(FEATURES, AROUND)));
  const without = millLineOf(milled(sequence(FEATURES, null)));
  const input = (field: string) => line.calculationTrace!.find((s) => s.kind === 'input' && s.fieldName === field)!;

  it('counts toward the station calculator\'s Rough Milling Time, with the roughing of the pockets', () => {
    expect(line.calculatorId).toBe('Machining - Milling');
    // 30.5716 s of bulk milling + 9 s of pocket roughing on the 8000 rpm mill: aluminium 0.13 mm/tooth (0.1 - 0.2 at Range Position 0.3)
    // x 3 teeth x 8000 rpm = 3120 mm/min; the 30 x 20 x 5 pocket 2 width x 3 depth passes of 45 mm (5.19 s -> 6 s), the 30 x 10 x 5 one
    // 1 x 3 (2.60 s -> 3 s).
    expect(input('Rough Milling Time')).toMatchObject({
      value: 39.5716, source: 'CAD features: Bulk Milling, Rough Milling (operation sequence)',
      ref: { kind: 'features', label: 'Rough Milling Time', features: [{ featureId: 'PocketV2-default_c2' }] },
    });
    expect(without.calculationTrace!.find((s) => s.fieldName === 'Rough Milling Time')).toMatchObject({ value: 9, source: 'CAD features: Rough Milling (operation sequence)' });
    // No other group moved.
    for (const field of ['Facing Time', 'Finish Milling Time', 'Contouring Time', 'Slot and Groove Milling Time', 'Hole Making Time', 'Edge Treatment Time', 'Other Operations Time']) {
      expect(input(field).value).toBe(without.calculationTrace!.find((s) => s.fieldName === field)!.value);
    }
  });

  it('makes the line longer by its time, one tool change and one rapid move', () => {
    const cutting = (l: typeof line) => l.calculationTrace!.find((s) => s.fieldName === 'Cutting Time')!.value as number;
    expect(cutting(line) - cutting(without)).toBeCloseTo(BULK_SEC, 2);
    // 30.5716 s, a 4.2 s tool change and a rapid move of 0.5 x 76 mm at 30 000 mm/min (0.076 s): 34.848 s.
    expect(line.cycleTimeMin * 60 - without.cycleTimeMin * 60).toBeCloseTo(34.848, 1);
    // At 900 per hour (0.25 per second): 8.71 more.
    expect(line.runCost - without.runCost).toBeCloseTo(8.71, 1);
  });

  it('shows its own calculation on the line, under its name', () => {
    const step = (field: string) => line.calculationTrace!.find((s) => s.fieldName === `Bulk Milling · ${field}`);
    expect(step('Removed Volume')).toMatchObject({
      value: 26584, unit: 'mm^3', source: 'Stock around the part: the piece 100000 mm^3 less the part 67785.04 mm^3 and the 5630.96 mm^3 its features remove',
    });
    expect(step('Material Removal Rate')).toMatchObject({ value: 60000 });
    expect(step('Cycle Time')).toMatchObject({ value: 30.5716 });
    expect(line.physicsGap).toBeUndefined();
    expect(without.calculationTrace!.some((s) => s.fieldName.startsWith('Bulk Milling ·'))).toBe(false);
  });

  it('is listed under the time it counts toward, with each pocket\'s roughing: the operations add up to that time, and each has its steps', () => {
    const summed = input('Rough Milling Time').sumOf!;
    // The bulk milling, then the two pockets (30 x 20 x 5 in 6 s, 30 x 10 x 5 in 3 s): two operations of one name, told apart by their number.
    expect(summed.map((o) => [o.name, o.seconds])).toEqual([['Bulk Milling', 30.5716], ['Rough Milling', 6], ['Rough Milling', 3]]);
    expect(summed.reduce((t, o) => t + o.seconds, 0)).toBeCloseTo(input('Rough Milling Time').value as number, 4);
    const stepsOf = (operation: number) => line.calculationTrace!.filter((s) => s.operation === operation);
    for (const o of summed) {
      const steps = stepsOf(o.operation);
      expect(new Set(steps.map((s) => s.group))).toEqual(new Set([o.name]));
      expect(steps.find((s) => s.kind === 'calculated' && s.groupField === 'Cycle Time')!.value).toBe(o.seconds);
    }
    const [, wide, narrow] = summed;
    expect(stepsOf(wide!.operation).find((s) => s.groupField === 'Cut Width')!.value).toBe(20);
    expect(stepsOf(narrow!.operation).find((s) => s.groupField === 'Cut Width')!.value).toBe(10);
    // The line's own steps are of no operation; every operation step is listed under exactly one time.
    const listed = line.calculationTrace!.filter((s) => s.kind === 'input').flatMap((s) => s.sumOf ?? []).map((o) => o.operation);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(line.calculationTrace!.flatMap((s) => (s.operation == null ? [] : [s.operation])))).toEqual(new Set(listed));
    expect(input('Rough Milling Time').operation).toBeUndefined();
    // A time nothing counts toward lists nothing.
    expect(input('Contouring Time').sumOf).toBeUndefined();
  });

  it('an operation the drawing puts a factor on is listed at its time on the line, with the factor', () => {
    // A fine surface finish on the drawing makes the wide pocket's roughing 1.3 times as long: 6 s -> 7.8 s.
    const ops = sequence(FEATURES, AROUND);
    const wide = ops.findIndex((o) => o.name === 'Rough Milling');
    const factored = millLineOf(milled(ops.map((o, i) => (i === wide ? { ...o, timeFactor: 1.3 } : o))));
    const summed = factored.calculationTrace!.find((s) => s.fieldName === 'Rough Milling Time')!.sumOf!;
    expect(summed.map((o) => [o.name, o.seconds, o.factor])).toEqual([['Bulk Milling', 30.5716, undefined], ['Rough Milling', 7.8, 1.3], ['Rough Milling', 3, undefined]]);
  });

  it('is a row of the line\'s feature breakdown, first: named, timed, and tied to no feature', () => {
    const warnings: string[] = [];
    const breakdown = (BomItemCostingService.prototype as unknown as {
      buildMachiningFeatureBreakdown(ops: OperationLine[], machineClass: string, categories: Record<string, string[]> | null, warnings: string[]): FeatureOp[];
    }).buildMachiningFeatureBreakdown;
    // The mills' operation categories name it (memory/Machining operations: "3 Axis Mill:Bulk Milling"): the name is confirmed, with no warning.
    // The plan timed on the 8000 rpm mill, as the route times it.
    const timed = timeOperations(sequence(FEATURES, AROUND), CALCS, { 'Max Spindle Speed': { value: 8000, source: 'Machine: test mill' } });
    const rows = breakdown(timed, '3_axis_mill', { '3_axis_mill': ['Facing', 'Bulk Milling', 'Rough Milling', 'Fine Finish Milling', 'Center Drilling', 'Drilling'] }, warnings);
    expect(rows[0]).toEqual({ name: 'Bulk Milling', timeSec: 31, featureType: '', count: 1 });
    expect(warnings).toEqual([]);
    expect(rows.filter((r) => r.name.startsWith('Rough Milling')).map((r) => [r.timeSec, r.featureIds])).toEqual([[9, ['PocketV2-default_c2']]]);
  });

  it('that could not be timed makes the mill line a named gap: the route is not fully costed', () => {
    const gap = millLineOf(milled(sequence([HOLES, FACE], stockExcess({ pieceMm3: PIECE_MM3, partMm3: PART_MM3, featureRemovedMm3: 1130.96 }), null)));
    expect((gap.physicsGap as { reason?: string } | undefined)?.reason).toContain('Bulk Milling: Material Removal Rate');
  });
});

describe('what the Bulk Milling of the stock around the part does not change', () => {
  it('a part with no stock chosen: no Bulk Milling, and no gap beyond the missing stock\'s own', () => {
    // The plan is given no piece, so its sequence has no Bulk Milling; the engine has no stock to price.
    const cost = milled(sequence(FEATURES, null), null);
    const line = millLineOf(cost);
    expect(cost.warnings).toContain(NO_STOCK_WARNING);
    expect(cost.warnings.some((w) => w.includes('Bulk Milling'))).toBe(false);
    expect(line.calculationTrace!.some((s) => s.fieldName.startsWith('Bulk Milling ·'))).toBe(false);
    expect(line.physicsGap).toBeUndefined();
    // The line is the one a part with stock has without the bulk operation.
    expect(line.cycleTimeMin).toBe(millLineOf(milled(sequence(FEATURES, null))).cycleTimeMin);
  });

  it('a part with no feature graph is, as before, one Bulk Milling of the whole stock-to-part volume', () => {
    // 100 000 - 67 785.04 = 32 214.96 mm^3; x 1.15 / 1000 = 37.047204 s, and nothing else on the line.
    const line = millLineOf(milled(undefined));
    expect(line.cycleTimeMin * 60).toBeCloseTo(37.047204, 1);
    expect(line.calculatorId).toBeUndefined();
  });

  it('a lathe route: the turning engine reads none of the mill\'s sequence', () => {
    const shaft = (featureOps?: OperationLine[]): MachiningCostInput => ({
      volume: 4000, surfaceArea: 1500, maxLength: 32, maxWidth: 14, maxHeight: 14,
      holeCount: 0, holeGroups: [], pocketCount: 0,
      materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
      materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
      batchSize: 100, family: 'turned', finishedWeightKg: 0.011,
      mhrRate: rate(900, { machineClass: '3_axis_lathe', setupTimeHr: 0.5, maxSpindleRpm: 4000 }),
      tappingRate: rate(900, { machineClass: 'tapping' }),
      deburrRate: rate(300, { machineClass: 'manual_deburr' }),
      inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
      surfaceTreatment: null,
      machiningCalculators: CALCS,
      turnedGeometry: {
        diameterMm: 14, lengthMm: 32, diameterSource: 'CAD: largest turned outer diameter (Ring feature)', lengthSource: 'CAD: bounding-box extent along the turning axis',
        rings: [{ id: 'od_0', diameterMm: 14, lengthMm: 8, faceIds: [9] }, { id: 'od_1', diameterMm: 12, lengthMm: 24, faceIds: [17] }],
      },
      blankResult: { form: 'round_bar', sizeLabel: 'Ø16 round bar', billetVolMm3: Math.PI * 8 ** 2 * 33, utilizationPct: 60, barDiameterMm: 16 },
      workbook: workbookFixture(),
      partoffTable: realPartoffTable(),
      ...(featureOps ? { featureOps } : {}),
    });
    const lathe = (input: MachiningCostInput) => computeTurningCostSummary(input, '3_axis_lathe' as MachineClassId);
    const withBulk = sequence(FEATURES, AROUND);
    expect(named(withBulk, 'Bulk Milling')).toHaveLength(1);
    expect(lathe(shaft(withBulk))).toEqual(lathe(shaft()));
    expect(lathe(shaft(withBulk)).processLines.some((l) => (l.calculationTrace ?? []).some((s) => s.fieldName.includes('Bulk Milling')))).toBe(false);
  });
});
