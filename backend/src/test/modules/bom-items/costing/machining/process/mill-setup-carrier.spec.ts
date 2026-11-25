// A mill is set up once for the batch, and the setup is charged on the first of its lines that has a cycle time: its milling line, else the
// part's loading and unloading (Part Setup), else the tapping or reaming the mill does. It was always charged on the milling line, so a
// mill with nothing to mill carried it on a line of 0 s, which reads as "no cycle time was resolved": a route with nothing missing was
// refused as not fully costed. The lathe has charged its setup this way since each turned diameter is turned on its own.
//
// The fixture has no feature graph, so the mill's time is one Bulk Milling of the stock less the part (the stored calculator):
//   Cycle Time = (V * 0.8 / MRR + V * 0.2 / (MRR * 0.4)) * 60, aluminium at 60,000 mm^3/min.
// The mill: 900 per hour, a 30 min setup over a batch of 100 = 0.3 min per part = 4.50.
import {
  computeMillingCostSummary,
  type MachiningCostInput,
  type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { findRouteDataGaps, lineDataGap } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { realCapabilityRules } from '../real-reference-tables';

import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { ProcessLineCost } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { workbookFixture } from '../workbook-fixture';

const CALCS = specAsCalculators();
const MILL = '3_axis_mill';
const mc = (s: string) => s as MachineClassId;
const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: MILL, machineName: 'Test VMC', commodityCode: null, ...extra } as MHRRateInput);

const SETUP_COST = 4.5;
// The mill's own spindle limit (mhr_records.specs spindle_speed_rpm, migration 1136): the tapping it does runs on that spindle.
const MILL_RATE = rate(900, { setupTimeHr: 0.5, maxSpindleRpm: 8000 });
// Tapping on the machining centre itself, as the service passes it when the location has no tapping machine of its own (inheritCncTappingRate).
const TAPPING_ON_THE_MILL = rate(900, { machineClass: 'tapping', hostMachineClass: MILL });
// componentLoadTime, the row for a part handled by hand (memory/Machining/lookup): weight kg, longest side mm, seconds.
const PART_SETUP = {
  loadTable: [{ equipment: 'None', weight_kg: 5, part_max_dimension_mm: 915, load_time_s: 10, unload_time_s: 10, reorientation_time_s: 10 }],
  setups: 1, adjustmentFactor: 1, repetitions: 1,
};
const billet = (volumeMm3: number) => ({ form: 'billet', sizeLabel: '50 x 40 x 20 billet', billetVolMm3: volumeMm3, utilizationPct: null });

/** A 28,000 mm^3 aluminium block with no holes, cut from a 40,000 mm^3 billet: 12,000 mm^3 to mill away. */
function block(overrides: Partial<MachiningCostInput> = {}): MachiningCostInput {
  return {
    volume: 28_000, surfaceArea: 7_600, maxLength: 50, maxWidth: 40, maxHeight: 20,
    holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 100, family: 'milled', finishedWeightKg: 0.0756,
    mhrRate: MILL_RATE, tappingRate: TAPPING_ON_THE_MILL,
    deburrRate: rate(300, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null,
    machiningCalculators: CALCS,
    millingRemovalRateMm3PerMin: 60_000,
    capabilityRules: realCapabilityRules(),
    workbook: workbookFixture(),
    partSetup: PART_SETUP,
    blankResult: billet(40_000),
    ...overrides,
  };
}

const cost = (input: MachiningCostInput) => computeMillingCostSummary(input, mc(MILL));
const lineOf = (lines: ProcessLineCost[], process: string) => lines.find((l) => l.process === process);
/** The lines on the mill itself (its own, and the operations it hosts), in order. */
const onTheMill = (lines: ProcessLineCost[]) => lines.filter((l) => l.machineClass === MILL || l.hostMachineClass === MILL);
const setupCarriers = (lines: ProcessLineCost[]) => onTheMill(lines).filter((l) => l.setupCost > 0).map((l) => l.process);

describe('the mill has milling to do: its milling line carries the setup, as it always did', () => {
  const result = cost(block());
  const milling = lineOf(result.processLines, '3 Axis Mill')!;

  it('the line is the bulk milling at the mill\'s rate plus the setup, and the route total is unchanged', () => {
    // Roughing Share 0.9 (1158): 12,000 * 0.9 / 60,000 = 0.18 min; 12,000 * 0.1 / 24,000 = 0.05 min; 0.23 min = 13.8 s; at 900 per hour = 3.45.
    expect(milling.cycleTimeMin * 60).toBeCloseTo(13.8, 4);
    expect(milling).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(milling.runCost).toBeCloseTo(3.45, 10);
    expect(milling.totalCost).toBeCloseTo(7.95, 10);
    expect(setupCarriers(result.processLines)).toEqual(['3 Axis Mill']);
    // Part Setup: load 10 s + unload 10 s = 20 s at 900 per hour = 5.00, with no setup of its own (closeTo: not rounded to cents).
    const partSetup = lineOf(result.processLines, 'Part Setup');
    expect(partSetup).toMatchObject({ setupCost: 0, setupTimeMin: 0, setupTimeSource: 'none' });
    expect(partSetup?.runCost).toBeCloseTo(5, 10);
    expect(partSetup?.totalCost).toBeCloseTo(5, 10);
    // The mill's share of the route: 7.95 + 5.00.
    expect(onTheMill(result.processLines).reduce((s, l) => s + l.totalCost, 0)).toBeCloseTo(12.95, 10);
    expect(result.warnings.some((w) => w.includes('setup not charged'))).toBe(false);
  });
});

describe('the mill has nothing to mill (the stock holds no more than the part, and it has no holes)', () => {
  // The stock is the part's own volume: nothing to remove, and nothing is missing.
  const nothingToMill = (overrides: Partial<MachiningCostInput> = {}) => block({ blankResult: billet(28_000), ...overrides });

  it('no milling line of 0 s is put on the route: Part Setup, the first line with work, carries the setup', () => {
    const { processLines, warnings } = cost(nothingToMill());
    expect(lineOf(processLines, '3 Axis Mill')).toBeUndefined();
    expect(onTheMill(processLines).map((l) => l.process)).toEqual(['Part Setup']);
    // 20 s at 900 per hour = 5.00, and the mill's setup 4.50 (closeTo: not rounded to cents).
    const partSetup = lineOf(processLines, 'Part Setup');
    expect(partSetup).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(partSetup?.runCost).toBeCloseTo(5, 10);
    expect(partSetup?.totalCost).toBeCloseTo(9.5, 10);
    expect(setupCarriers(processLines)).toEqual(['Part Setup']);
    // Nothing on the mill is a gap: the route is fully costed.
    expect(onTheMill(processLines).map(lineDataGap)).toEqual([null]);
    expect(warnings.some((w) => w.includes('setup not charged'))).toBe(false);
  });

  it('with no part handling priced, the tapping the mill does carries it', () => {
    const { processLines } = cost(nothingToMill({ partSetup: undefined, threads: [{ size: 'M4', count: 2, depthMm: 8 }] }));
    const tapping = lineOf(processLines, 'Tapping')!;
    expect(onTheMill(processLines).map((l) => l.process)).toEqual(['Tapping']);
    expect(tapping.cycleTimeMin).toBeGreaterThan(0);
    expect(tapping).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(tapping.totalCost).toBeCloseTo(SETUP_COST + tapping.runCost, 10);
    expect(lineDataGap(tapping)).toBeNull();
  });

  it('a tapping machine of its own is set up as itself, never with the mill\'s setup', () => {
    const own = rate(600, { machineClass: 'tapping', machineName: 'Tapping machine', setupTimeHr: 0.25, maxSpindleRpm: 3000 });
    const { processLines, warnings } = cost(nothingToMill({ partSetup: undefined, threads: [{ size: 'M4', count: 2, depthMm: 8 }], tappingRate: own }));
    // 15 min over 100 parts at 600 per hour = 1.50: the tapping machine's own setup.
    expect(lineOf(processLines, 'Tapping')).toMatchObject({ setupCost: 1.5, setupTimeMin: 15, setupTimeSource: 'machine' });
    expect(onTheMill(processLines)).toEqual([]);
    expect(warnings).toContain('3 Axis Mill: setup not charged — nothing on the machine has a cycle time for this part.');
  });

  it('the setup is charged once: Part Setup takes it, and the tapping after it does not', () => {
    const { processLines } = cost(nothingToMill({ threads: [{ size: 'M4', count: 2, depthMm: 8 }] }));
    expect(onTheMill(processLines).map((l) => l.process)).toEqual(['Part Setup', 'Tapping']);
    expect(setupCarriers(processLines)).toEqual(['Part Setup']);
    expect(lineOf(processLines, 'Tapping')).toMatchObject({ setupCost: 0, setupTimeMin: 0, setupTimeSource: 'none' });
  });

  it('with nothing at all on the mill no setup is charged, and the quote says so', () => {
    const { processLines, warnings, totalProcessCost } = cost(nothingToMill({ partSetup: undefined }));
    expect(onTheMill(processLines)).toEqual([]);
    expect(warnings).toContain('3 Axis Mill: setup not charged — nothing on the machine has a cycle time for this part.');
    expect(totalProcessCost).toBe(processLines.reduce((s, l) => s + l.totalCost, 0));
  });
});

describe('milling that cannot be priced stays on the route as a named gap, and carries the setup', () => {
  it('no stock is chosen: the line names the stock, and nothing after it takes the setup', () => {
    const { processLines, warnings } = cost(block({ blankResult: undefined }));
    const milling = lineOf(processLines, '3 Axis Mill')!;
    expect(milling.cycleTimeMin).toBe(0);
    expect(milling.physicsGap).toMatchObject({ gapType: 'unsupported_operation', reason: expect.stringContaining('the stock the part is cut from') });
    expect(milling).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(setupCarriers(processLines)).toEqual(['3 Axis Mill']);
    expect(findRouteDataGaps(processLines).map((g) => g.process)).toContain('3 Axis Mill');
    expect(warnings).toContain('Bulk Milling not priced — missing real input: the stock the part is cut from.');
  });

  it('the same gap is named on a mill with no setup time on file, where the line used to be left out', () => {
    const { processLines } = cost(block({ blankResult: undefined, mhrRate: rate(900) }));
    const milling = lineOf(processLines, '3 Axis Mill')!;
    expect(milling.physicsGap).toMatchObject({ reason: expect.stringContaining('the stock the part is cut from') });
    expect(milling.setupCost).toBe(0);
  });

  it('the material has no removal rate on file: the line names it', () => {
    const { processLines } = cost(block({ millingRemovalRateMm3PerMin: null }));
    const milling = lineOf(processLines, '3 Axis Mill')!;
    expect(milling.cycleTimeMin).toBe(0);
    expect((milling.physicsGap as { reason?: string }).reason).toContain('Material Removal Rate');
    expect(setupCarriers(processLines)).toEqual(['3 Axis Mill']);
    expect(lineOf(processLines, 'Part Setup')).toMatchObject({ setupCost: 0 });
  });

  it('the station has no calculator for the part\'s feature operations: the gap line carries the setup', () => {
    const { processLines } = cost(block({ featureOps: [{ name: 'Facing', timeSec: 45, source: 'fixed' }], machiningCalculators: {} }));
    const milling = lineOf(processLines, '3 Axis Mill')!;
    expect(milling.cycleTimeMin).toBe(0);
    expect(milling.physicsGap).toBeDefined();
    expect(setupCarriers(processLines)).toEqual(['3 Axis Mill']);
  });
});
