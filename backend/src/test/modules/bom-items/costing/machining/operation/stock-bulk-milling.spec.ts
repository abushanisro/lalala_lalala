// A mill removes the stock around the part. The operations the sequencer plans act on the part's features (a pocket, a hole, a face), so
// between the piece the mill starts from and the part nothing was milled away: STIFFNER 2, a 15 208 mm^3 part from a 105 613 mm^3 piece of
// bar, was costed 32 s of roughing for its one pocket and not a second for the other 65 638 mm^3.
//
// The plan of a milled route now has one more operation, "Bulk Milling" of the stock excess (stock-excess.ts):
//
//   stock excess = piece volume - part volume - volume the part's features remove
//
// timed by the stored calculator "Machining - Bulk Milling" (the fields of Rough Milling):
//
//   Cycle Time = (Removed Volume * 0.8 / Removal Rate + Removed Volume * 0.2 / (Removal Rate * 0.4)) * 60        [s]
//
// which for aluminium (60 000 mm^3/min, tblMillingRemovalRate) is Removed Volume * 1.3 / 1000 seconds. Every expected number below is
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
import { realDrillingTable, realPartoffTable } from '../real-reference-tables';

import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { FeatureOp } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';

const CALCS = specAsCalculators();
const ALUMINIUM: MillingFinishingRow = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
const ASSUMED = 'Assumption: Machining - Bulk Milling default value (database) — no reference source';

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
// 26 584 x 1.3 / 1000 = 34.5592 s.
const BULK_SEC = 34.5592;

const sequence = (features: unknown[] | null, stockAround: StockExcess | null, removalRate: number | null = 60000, machinabilityFactor = 1.0) =>
  buildOperationSequence(features, 'aluminum', machinabilityFactor, 'Aluminum, ANSI 6061', null, null, null, realDrillingTable(), CALCS, null, removalRate, ALUMINIUM, stockAround);
const named = (ops: OperationLine[], name: string) => ops.filter((o) => o.name === name);

describe('the sequencer mills away the stock around the part', () => {
  it('the fixture\'s stock excess is 26 584 mm^3', () => {
    expect(AROUND.featureRemovedMm3).toBeCloseTo(5630.96, 6);
    expect(AROUND.excessMm3).toBeCloseTo(26584, 6);
    expect(AROUND.excessMm3).toBeCloseTo(PIECE_MM3 - 76 * 46 * 21, 6);
  });

  it('as one Bulk Milling operation after Facing, timed by the stored calculator on that volume at the material\'s removal rate', () => {
    const ops = sequence(FEATURES, AROUND);
    expect(ops.slice(0, 2).map((o) => o.name)).toEqual(['Facing', 'Bulk Milling']);
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
    expect(op!.timeSec).toBeCloseTo((26584 * 0.8 / 60000 + 26584 * 0.2 / (60000 * 0.4)) * 60, 6);
    expect(op!.calculator).toMatchObject({ id: 'Machining - Bulk Milling' });
    expect(op!.trace!.filter((s) => s.kind === 'input').map((s) => [s.fieldName, s.value, s.source])).toEqual([
      ['Removed Volume', 26584, 'Stock around the part: the piece 100000 mm^3 less the part 67785.04 mm^3 and the 5630.96 mm^3 its features remove'],
      ['Material Removal Rate', 60000, 'tblMillingRemovalRate: aluminum 60000 mm^3/min x machinability factor 1'],
      ['Roughing Share', 0.8, ASSUMED],
      ['Finishing Rate Factor', 0.4, ASSUMED],
    ]);
    expect(op!.calculator!.lookups).toEqual({ 'Material Removal Rate': { table: 'tblMillingRemovalRate', row: { MaterialClass: 'aluminum' } } });
  });

  it('changes none of the operations on the features: they are what they are without it', () => {
    const without = sequence(FEATURES, null);
    expect(named(without, 'Bulk Milling')).toEqual([]);
    expect(sequence(FEATURES, AROUND).filter((o) => o.name !== 'Bulk Milling')).toEqual(without);
    // The pockets are still roughed on their own volume: 4500 x 1.3 / 1000 = 5.85 s.
    expect(named(without, 'Rough Milling')[0]!.timeSec).toBeCloseTo(5.85, 6);
  });

  it('the removal rate carries the material\'s machinability, as the roughing of a pocket does', () => {
    // Twice the baseline machinability: 120 000 mm^3/min, 26 584 x 1.3 / 2000 = 17.2796 s.
    const [op] = named(sequence(FEATURES, AROUND, 60000, 2.0), 'Bulk Milling');
    expect(op!.trace!.find((s) => s.fieldName === 'Material Removal Rate')).toMatchObject({ value: 120000 });
    expect(op!.timeSec).toBeCloseTo(17.2796, 6);
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

  it('a turned diameter costed on a mill is still charged as its own Bulk Milling, after the stock\'s', () => {
    // The ring states its cylinder (900 mm^3), which the sequencer bulk mills: it is counted among the features, so the stock's is the rest.
    const ring = { id: 'Ring-outer_diameter_d14.0_c1', feature_type: 'Ring', variant: 'outer_diameter', diameter_mm: 14, occurrences: [{ depth_mm: 5.85, material_removed_mm3: 900 }] };
    const around = stockExcess({ pieceMm3: 3000, partMm3: 1600, featureRemovedMm3: featureRemovedVolumeMm3([ring]) });
    expect(around.excessMm3).toBe(500);
    const bulk = named(sequence([ring], around), 'Bulk Milling');
    expect(bulk.map((o) => [o.source, o.featureIds, Math.round(o.timeSec * 1e6) / 1e6])).toEqual([
      ['fixed', undefined, 0.65],
      ['feature', ['Ring-outer_diameter_d14.0_c1'], 1.17],
    ]);
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
    mhrRate: rate(900, { machineClass: '3_axis_mill', setupTimeHr: 0.5 }),
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
    // 34.5592 s of bulk milling + 5.85 s of pocket roughing.
    expect(input('Rough Milling Time')).toMatchObject({
      value: 40.4092, source: 'CAD features: Bulk Milling, Rough Milling (operation sequence)',
      ref: { kind: 'features', label: 'Rough Milling Time', features: [{ featureId: 'PocketV2-default_c2' }] },
    });
    expect(without.calculationTrace!.find((s) => s.fieldName === 'Rough Milling Time')).toMatchObject({ value: 5.85, source: 'CAD features: Rough Milling (operation sequence)' });
    // No other group moved.
    for (const field of ['Facing Time', 'Finish Milling Time', 'Contouring Time', 'Slot and Groove Milling Time', 'Hole Making Time', 'Edge Treatment Time', 'Other Operations Time']) {
      expect(input(field).value).toBe(without.calculationTrace!.find((s) => s.fieldName === field)!.value);
    }
  });

  it('makes the line longer by exactly its time x 1.15 (the rapids and tool change allowance)', () => {
    const cutting = (l: typeof line) => l.calculationTrace!.find((s) => s.fieldName === 'Cutting Time')!.value as number;
    expect(cutting(line) - cutting(without)).toBeCloseTo(BULK_SEC, 2);
    // 34.5592 x 1.15 = 39.743 s.
    expect(line.cycleTimeMin * 60 - without.cycleTimeMin * 60).toBeCloseTo(39.743, 1);
    // At 900 per hour (0.25 per second): 9.94 more.
    expect(line.runCost - without.runCost).toBeCloseTo(9.94, 1);
  });

  it('shows its own calculation on the line, under its name', () => {
    const step = (field: string) => line.calculationTrace!.find((s) => s.fieldName === `Bulk Milling · ${field}`);
    expect(step('Removed Volume')).toMatchObject({
      value: 26584, unit: 'mm^3', source: 'Stock around the part: the piece 100000 mm^3 less the part 67785.04 mm^3 and the 5630.96 mm^3 its features remove',
    });
    expect(step('Material Removal Rate')).toMatchObject({ value: 60000 });
    expect(step('Cycle Time')).toMatchObject({ value: 34.5592 });
    expect(line.physicsGap).toBeUndefined();
    expect(without.calculationTrace!.some((s) => s.fieldName.startsWith('Bulk Milling ·'))).toBe(false);
  });

  it('is a row of the line\'s feature breakdown, after Facing: named, timed, and tied to no feature', () => {
    const warnings: string[] = [];
    const breakdown = (BomItemCostingService.prototype as unknown as {
      buildMachiningFeatureBreakdown(ops: OperationLine[], machineClass: string, categories: Record<string, string[]> | null, warnings: string[]): FeatureOp[];
    }).buildMachiningFeatureBreakdown;
    // The mills' operation categories name it (memory/Machining operations: "3 Axis Mill:Bulk Milling"): the name is confirmed, with no warning.
    const rows = breakdown(sequence(FEATURES, AROUND), '3_axis_mill', { '3_axis_mill': ['Facing', 'Bulk Milling', 'Rough Milling', 'Fine Finish Milling', 'Center Drilling', 'Drilling'] }, warnings);
    expect(rows.slice(0, 2)).toEqual([
      { name: 'Facing', timeSec: 45, featureType: '', count: 1 },
      { name: 'Bulk Milling', timeSec: 35, featureType: '', count: 1 },
    ]);
    expect(warnings).toEqual([]);
    expect(rows.find((r) => r.name.startsWith('Rough Milling'))).toMatchObject({ timeSec: 6, featureIds: ['PocketV2-default_c2'] });
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
    // 100 000 - 67 785.04 = 32 214.96 mm^3; x 1.3 / 1000 = 41.879448 s, and nothing else on the line.
    const line = millLineOf(milled(undefined));
    expect(line.cycleTimeMin * 60).toBeCloseTo(41.879448, 1);
    expect(line.calculatorId).toBeUndefined();
  });

  it('a lathe route: the turning engine reads none of the mill\'s sequence', () => {
    const shaft = (featureOps?: OperationLine[]): MachiningCostInput => ({
      volume: 4000, surfaceArea: 1500, maxLength: 32, maxWidth: 14, maxHeight: 14,
      holeCount: 0, holeGroups: [], pocketCount: 0,
      materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
      materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
      batchSize: 100, family: 'turned', finishedWeightKg: 0.011,
      mhrRate: rate(900, { machineClass: '3_axis_lathe', setupTimeHr: 0.5 }),
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
      turningParams: {
        roughCutDepthMm: 1.3, roughCuttingSpeedMPerMin: 250.4, roughFeedMmPerRev: 0.3625,
        finishCutDepthMm: 0.8, finishCuttingSpeedMPerMin: 333.1, finishFeedMmPerRev: 0.29, dataFound: true,
      },
      drillingTable: realDrillingTable(),
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
