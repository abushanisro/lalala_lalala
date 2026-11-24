// The perimeter cut of Perimeter Milling with Drop-off on the mill that makes the part: one more operation of the mill's own line
// ("Perimeter Milling", in the station calculator's Contouring Time with the part's own contouring), with its own calculation steps and its
// own row of the line's breakdown, and with the bulk left inside the cut as the line's Bulk Milling. Worked by hand in the comments.
//
// The fixture: STIFFNER 2's outline (397.81 mm, 5058.6 mm²) through a 12.7 mm aluminium plate. The cut: 7 passes of 407.81 mm at 1398.017
// mm/min = 122.5165 s (perimeter-cut.spec.ts).
import { BomItemCostingService } from '../../../../../modules/bom-items/bom-item-costing.service';
import { specAsCalculators } from '../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildOperationSequence, type MillingFinishingRow, type OperationLine } from '../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { featureRemovedVolumeMm3, stockExcess } from '../../../../../modules/bom-items/costing/machining/operation/stock-excess';
import {
  computeMillingCostSummary, millingOperationsCost, type MachineClassId, type MachiningCostInput,
} from '../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { stockMachiningCalculatorsByName } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculator-spec';
import { perimeterCutOperation, slottingRuleOf } from '../../../../../modules/bom-items/costing/stock-machining/perimeter-cut';

import type { MHRRateInput } from '../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { FeatureOp } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';

const CALCS = specAsCalculators();
const ALUMINIUM: MillingFinishingRow = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
const CUT_SEC = (7 * 407.81) / ((183000 / (Math.PI * 10)) * 3 * 0.008 * 10) * 60; // 122.5165 s
const CUT = perimeterCutOperation({
  calculators: stockMachiningCalculatorsByName(), outlinePerimeterMm: 397.81, plateThicknessMm: 12.7, finishing: ALUMINIUM, matClass: 'aluminum', machinabilityFactor: 1,
  slotting: slottingRuleOf(CALCS)!,
});

// The part: 15 208.37 mm³, a pocket of 24 432.94 mm³, a face to finish, and a window through it whose wall (600 mm²) is perimeter milled.
const POCKET = { id: 'PocketV2-default_c1', feature_type: 'PocketV2', variant: 'default', occurrences: [{ extents_mm: [150, 30, 0], depth_mm: 5.43, material_removed_mm3: 24432.94 }] };
const FACE = { id: 'PlanarFace-default_c1', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ area_mm2: 2000, material_removed_mm3: 0 }] };
const WINDOW = { id: 'Cutout-default_c1', feature_type: 'Cutout', variant: 'default', occurrences: [{ area_mm2: 600, material_removed_mm3: 0 }] };
const PART_MM3 = 15208.37;
// The prism inside the cut: 5058.6 x 12.7 = 64 244.22 mm³. Less the part and the pocket: 64 244.22 - 15 208.37 - 24 432.94 = 24 602.91 mm³.
const PIECE_MM3 = 5058.6 * 12.7;
const sequence = (features: unknown[], stockOps: OperationLine[]) => buildOperationSequence(
  features, { matClass: 'aluminum', machinabilityFactor: 1, materialGrade: 'Aluminum, ANSI 6061', calculators: CALCS, removalRateMm3PerMin: 60000, finishing: ALUMINIUM, stockAround: stockExcess({ pieceMm3: PIECE_MM3, partMm3: PART_MM3, featureRemovedMm3: featureRemovedVolumeMm3(features) }), stockOps },
);

const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);
const MILL = rate(900, { machineClass: '3_axis_mill', setupTimeHr: 0.5, labourRate: 36, operators: 1 });
function milled(featureOps: OperationLine[]) {
  const input: MachiningCostInput = {
    volume: PART_MM3, surfaceArea: 15000, maxLength: 159.5, maxWidth: 42, maxHeight: 8, holeCount: 0, holeGroups: [], pocketCount: 1,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700, materialSource: 'db', threads: [], tightestToleranceMm: null,
    gdtFeatureCount: 0, batchSize: 100, family: 'milled', finishedWeightKg: 0.041, mhrRate: MILL, tappingRate: rate(900, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'manual_deburr' }), inspectionRate: rate(450, { machineClass: 'machining_inspection' }), surfaceTreatment: null,
    machiningCalculators: CALCS, millingRemovalRateMm3PerMin: 60000, featureOps,
    blankResult: { form: 'plate', sizeLabel: '1/2" plate, 159.5 x 42 mm outline', billetVolMm3: PIECE_MM3, utilizationPct: 11.5, purchasedVolMm3: 132735.2184 },
  };
  return computeMillingCostSummary(input, '3_axis_mill' as MachineClassId);
}
const millLineOf = (cost: ReturnType<typeof milled>) => cost.processLines.find((l) => l.process === '3 Axis Mill')!;

describe('the sequence of a part cut out of the plate by the mill', () => {
  it('has the perimeter cut, and bulk mills what is left inside it', () => {
    const ops = sequence([POCKET, FACE], [CUT]);
    expect(ops.map((o) => o.name)).toEqual(['Facing', 'Bulk Milling', 'Fine Finish Milling', 'Fine Finish Milling', 'Perimeter Milling', 'Rough Milling', 'Deburr']);
    // 24 602.91 mm³ at 60 000 mm³/min: x 1.3 / 1000 = 31.983783 s.
    const bulk = ops.find((o) => o.name === 'Bulk Milling')!;
    expect(bulk.trace!.find((s) => s.fieldName === 'Removed Volume')!.value).toBeCloseTo(24602.91, 2);
    expect(bulk.timeSec).toBeCloseTo(31.983783, 4);
    expect(ops.find((o) => o.name === 'Perimeter Milling')!.timeSec).toBeCloseTo(CUT_SEC, 9);
  });
});

describe('on the mill line, the perimeter cut', () => {
  const line = millLineOf(milled(sequence([POCKET, FACE], [CUT])));
  const without = millLineOf(milled(sequence([POCKET, FACE], [])));
  const input = (l: typeof line, field: string) => l.calculationTrace!.find((s) => s.kind === 'input' && s.fieldName === field)!;

  it('counts toward the station calculator\'s Contouring Time, the group Perimeter Milling maps to', () => {
    // The trace shows a value to the calculator runner's rounding: 122.5165 s reads 122.52.
    expect(input(line, 'Contouring Time')).toMatchObject({ value: 122.52, source: 'CAD features: Perimeter Milling (operation sequence)' });
    expect(input(without, 'Contouring Time')).toMatchObject({ value: 0, source: 'CAD features: none of this group on the part' });
    for (const field of ['Facing Time', 'Rough Milling Time', 'Finish Milling Time', 'Slot and Groove Milling Time', 'Hole Making Time', 'Edge Treatment Time', 'Other Operations Time']) {
      expect(input(line, field).value).toBe(input(without, field).value);
    }
  });

  it('makes the line longer by its time x 1.15, at the mill\'s rate and labour', () => {
    // 122.5165 x 1.15 = 140.894 s. At 900 an hour that is 35.22, and 1.41 of labour at 36 an hour: 36.63.
    expect(line.cycleTimeMin * 60 - without.cycleTimeMin * 60).toBeCloseTo(140.894, 1);
    expect(line.runCost - without.runCost).toBeCloseTo(36.63, 1);
  });

  it('costs on its own what it adds to the line: the figure the roughing list shows for the quoted mill', () => {
    const cost = millingOperationsCost(CALCS, MILL, '3_axis_mill' as MachineClassId, [{ name: 'Perimeter Milling', timeSec: CUT_SEC, source: 'stock' }])!;
    // 140.894 s: 35.22 of machine at 900 an hour + 35.22 / 900 x 36 = 1.41 of labour.
    expect(cost).toBeCloseTo(36.63, 2);
    expect(cost).toBeCloseTo(line.runCost - without.runCost, 1);
    // With no station calculator on file there is no figure, not an estimate.
    expect(millingOperationsCost({}, MILL, '3_axis_mill' as MachineClassId, [{ name: 'Perimeter Milling', timeSec: CUT_SEC, source: 'stock' }])).toBeNull();
  });

  it('shows its own calculation on the line, under its name', () => {
    const step = (field: string) => line.calculationTrace!.find((s) => s.fieldName === `Perimeter Milling · ${field}`);
    expect(step('Outline Perimeter')).toMatchObject({ value: 397.81, unit: 'mm' });
    expect(step('Plate Thickness')).toMatchObject({ value: 12.7 });
    expect(step('Passes')).toMatchObject({ value: 7 });
    expect(step('Path per Pass')).toMatchObject({ value: 407.81 });
    expect(step('Cycle Time')).toMatchObject({ value: 122.52, unit: 's' });
    expect(line.physicsGap).toBeUndefined();
    expect(without.calculationTrace!.some((s) => s.fieldName.startsWith('Perimeter Milling ·'))).toBe(false);
  });

  it('a cut that could not be timed makes the mill line a named gap', () => {
    const untimed: OperationLine = { ...CUT, timeSec: 0, missing: 'Stock Machining - Perimeter Cut: Cutter Diameter' };
    const gap = millLineOf(milled(sequence([POCKET, FACE], [untimed])));
    expect((gap.physicsGap as { reason?: string } | undefined)?.reason).toContain('Stock Machining - Perimeter Cut: Cutter Diameter');
  });
});

describe('in the line\'s feature breakdown, the perimeter cut', () => {
  const breakdown = (BomItemCostingService.prototype as unknown as {
    buildMachiningFeatureBreakdown(ops: OperationLine[], machineClass: string, categories: Record<string, string[]> | null, warnings: string[]): FeatureOp[];
  }).buildMachiningFeatureBreakdown;
  const categories = { '3_axis_mill': ['Facing', 'Bulk Milling', 'Rough Milling', 'Fine Finish Milling', 'Perimeter Milling'] };

  it('is a row of its own on the part\'s Perimeter, named by the catalog and tied to no feature', () => {
    const warnings: string[] = [];
    const rows = breakdown(sequence([POCKET, FACE], [CUT]), '3_axis_mill', categories, warnings);
    expect(rows.filter((r) => r.name.startsWith('Perimeter Milling'))).toEqual([{ name: 'Perimeter Milling', timeSec: 123, featureType: 'Perimeter', count: 1 }]);
    expect(warnings).toEqual([]);
  });

  it('stays its own row beside the perimeter milling of a window through the part', () => {
    const rows = breakdown(sequence([POCKET, FACE, WINDOW], [CUT]), '3_axis_mill', categories, []);
    const perimeter = rows.filter((r) => r.name.startsWith('Perimeter Milling'));
    expect(perimeter).toHaveLength(2);
    expect(perimeter.find((r) => r.featureType === 'Perimeter')).toEqual({ name: 'Perimeter Milling', timeSec: 123, featureType: 'Perimeter', count: 1 });
    expect(perimeter.find((r) => r.featureType === 'Cutout')).toMatchObject({ name: 'Perimeter Milling', featureIds: ['Cutout-default_c1'] });
  });

  it('a part with no perimeter cut has the rows it had', () => {
    const rows = breakdown(sequence([POCKET, FACE, WINDOW], []), '3_axis_mill', categories, []);
    expect(rows.filter((r) => r.name.startsWith('Perimeter Milling'))).toEqual([expect.objectContaining({ featureType: 'Cutout' })]);
  });
});
