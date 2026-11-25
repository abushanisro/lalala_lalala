// Hand-calculated checks of the machining cost chain against the reference
// data (memory/Machining, memory/Stock Maching), an end-to-end run through the
// real calculators, and regressions for the defects the audit found.
import {
  computeDrillCycle,
  computeMillingCostSummary,
  computeTurningCostSummary,
  detectMaterialClass,
  type MachineClassId,
  type MachiningCostInput,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import {
  realCapabilityRules, realPartoffTable, realRotaryBroachReference, } from '../real-reference-tables';
import { workbookFixture } from '../workbook-fixture';

const CALCS = specAsCalculators();
const DRILLING = workbookFixture();
const mc = (v: string): MachineClassId => v as MachineClassId;

function rate(value: number, o: Partial<MHRRateInput> = {}): MHRRateInput {
  // The test mill's rapid traverse rate (mhr_records.specs rapid_traverse_mm_per_min, migration 1141).
  return { rate: value, source: 'mhr_database', machineClass: '3_axis_mill', machineName: 'Test VMC', commodityCode: 'X', rapidTraverseMmPerMin: 30000, ...o };
}

/** A billet of these sizes as the stock a part is cut from. The engine sizes no stock itself: the stock model chooses it (costing/stock). */
const billet = (l: number, w: number, h: number) => ({ form: 'billet', sizeLabel: `${l}×${w}×${h} billet`, billetVolMm3: l * w * h, utilizationPct: null });

function input(o: Partial<MachiningCostInput> = {}): MachiningCostInput {
  return {
    volume: 40_000, surfaceArea: 20_000, maxLength: 100, maxWidth: 50, maxHeight: 20,
    holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'AISI 1018', materialCostPerKg: 80, materialDensityKgM3: 7850, materialSource: 'db',
    threads: [], tightestToleranceMm: null, gdtFeatureCount: 0, batchSize: 10, family: 'milled',
    finishedWeightKg: 0.3,
    mhrRate: rate(600), tappingRate: rate(600, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'deburring', machineName: null }),
    inspectionRate: rate(450, { machineClass: 'cmm', machineName: null, commodityCode: null }),
    surfaceTreatment: null, machiningCalculators: CALCS, capabilityRules: realCapabilityRules(), location: 'India',
    // The machining variables' rapidTransferDistanceFactor (migration 639).
    rapidTransferDistanceFactor: 0.5,
    ...o,
  };
}

// ── Reference values, read off the machining workbook's drilling table ─────────
// "STEEL-LOW & MEDIUM STRENGTH WROUGHT" (the mild-steel row), Drilling: 9-25 m/min (13.8 at the Range Position 0.3);
// feed 0.46 mm/rev in the 19-26 mm band.
const DRILL_SPEED = 13.8;
const DRILL_FEED_AT_19_9 = 0.46;
const MILL_8K = { 'Max Spindle Speed': { value: 8000, source: 'Machine: test spindle_speed_rpm' } };

describe('hand-calculated cost chain', () => {
  it('drilling: 3 holes of Ø19.9 x 40 mm = holes x ceil((depth + 10) / (rpm x feed) x 60), as the workbook\'s Drilling sheet times them', () => {
    // n = 13 800 / (pi x 19.9) = 220.74 rpm (under the 8000 rpm spindle); (40 + 10) / (0.46 x 220.74) = 0.4924 min = 29.54 s -> 30 s a hole.
    const rpm = (DRILL_SPEED * 1000) / (Math.PI * 19.9);
    const perHole = Math.ceil(((40 + 10) / (rpm * DRILL_FEED_AT_19_9)) * 60);
    expect(perHole).toBe(30);
    const cycle = computeDrillCycle(19.9, 'AISI 1018', 40, DRILLING, CALCS, 3, undefined, MILL_8K);
    expect(cycle.missing).toEqual([]);
    expect(cycle.sec).toBe(3 * perHole);
  });

  it('material: the weight of the stock chosen for the part x price (no markup)', () => {
    const bare = computeMillingCostSummary(input({ blankResult: billet(100, 50, 20) }), mc('3_axis_mill'));
    // 100 x 50 x 20 mm = 1e5 mm3 = 1e-4 m3 x 7850 = 0.785 kg x 80 = 62.80
    expect(bare.materialRemoval!.billetWeightKg).toBeCloseTo(0.785, 3);
    expect(bare.materialCost).toBeCloseTo(62.8, 2);
    // 2 mm of stock on each side: 104 x 54 x 24 = 134 784 mm3 -> 1.058 kg (r3) x 80 = 84.64
    const allowed = computeMillingCostSummary(input({ blankResult: billet(104, 54, 24) }), mc('3_axis_mill'));
    expect(allowed.materialRemoval!.billetWeightKg).toBeCloseTo(1.058, 3);
    expect(allowed.materialCost).toBeCloseTo(84.64, 2);
  });

  it('setup: machine setup_time_hr x rate / batch, plus the fixture / batch; run = (cutting + tool changes + rapids) x rate', () => {
    const result = computeMillingCostSummary(input({
      blankResult: billet(100, 50, 20), batchSize: 10, fixtureUnitCostLocal: 100,
      mhrRate: rate(600, { setupTimeHr: 0.5 }),
      featureOps: [{ name: 'Rough Mill', timeSec: 600, source: 'fixed' }, { name: 'Tapping', timeSec: 999, source: 'fixed' }],
    }), mc('3_axis_mill'));
    const line = result.processLines.find((l) => l.process === '3 Axis Mill')!;
    // 30 min / 10 parts = 3 min x 600/h = 30.00, + fixture 100 / 10 = 10.00
    expect(line.setupCost).toBeCloseTo(40, 2);
    expect(line.setupTimeMin).toBe(30);
    // 600 s of cutting (Tapping is billed on its own line, not here), one 4.2 s tool change (Haas VF-2 tool-to-tool) and one rapid
    // move of 0.5 x 100 mm at 30 000 mm/min (0.1 s): 604.3 s = 10.0717 min x 600/h = 100.72
    expect(line.cycleTimeMin).toBeCloseTo(10.0717, 4);
    expect(line.runCost).toBeCloseTo(100.72, 2);
    expect(line.totalCost).toBeCloseTo(140.72, 2);
  });

  it('turning, timed as the workbook\'s Turning sheet times a cut: whole passes over the stock, each the length + 10 mm at the start diameter\'s speed', () => {
    const result = computeTurningCostSummary(input({
      family: 'turned', maxLength: 80, maxWidth: 32, maxHeight: 32, volume: 50_000,
      mhrRate: rate(900, { machineClass: '2_axis_lathe', maxSpindleRpm: 4000 }),
      blankResult: { form: 'round_bar', sizeLabel: 'Ø40', barDiameterMm: 40, billetVolMm3: Math.PI * 20 ** 2 * 80, utilizationPct: 50, endAllowanceMm: 0.5 },
      workbook: workbookFixture(), partoffTable: realPartoffTable(),
    }), mc('2_axis_lathe'));
    // AISI 1018 is the workbook's "Mild steels" on carbide, at the Range Position 0.3: rough (2 mm deep) 120-200 m/min and 0.2-0.3
    // mm/rev -> 144 and 0.23; finish (0.5 mm deep) 150-450 and 0.05-0.2 -> 240 and 0.095. Machining time = (L + 10) / (feed x n) x passes, n = 1000 v / (pi D) at the
    // diameter the cut starts at, under the lathe's 4000 rpm.
    const minutes = (v: number, f: number, startDiameterMm: number, passes: number) => ((80 + 10) / (f * ((v * 1000) / (Math.PI * startDiameterMm)))) * passes;
    // Ø32 from a Ø40 bar. The finish cut starts at 32 + 2 x 0.5 = 33 mm, so roughing takes ceil((40 - 33) / 4) = 2 passes from the bar,
    // at 1145.92 rpm: 0.6830 min = 40.98 s -> 41 s. The finish pass, from Ø33 at 2314.98 rpm: 24.55 s -> 25 s.
    expect(minutes(144, 0.23, 40, 2) * 60).toBeCloseTo(40.98, 2);
    expect(minutes(240, 0.095, 33, 1) * 60).toBeCloseTo(24.55, 2);
    const rough = result.processLines.find((l) => l.process === 'Rough Turning')!;
    const finish = result.processLines.find((l) => l.process === 'Finish Turning')!;
    expect(rough.cycleTimeMin * 60).toBeCloseTo(41, 1);
    expect(finish.cycleTimeMin * 60).toBeCloseTo(25, 1);
    expect(rough.runCost).toBeCloseTo((41 / 3600) * 900, 6);
  });
});

describe('detectMaterialClass', () => {
  it.each([
    ['AL6061-T6', 'aluminum'], ['Aluminium 6082', 'aluminum'], ['Aluminum 5083', 'aluminum'], ['AL6063', 'aluminum'],
    ['EN AW-6082', 'aluminum'], ['Al 7050', 'aluminum'],
    ['Brass C360', 'copper_alloy'], ['C36000', 'copper_alloy'], ['Bronze', 'copper_alloy'], ['Copper C110', 'copper_alloy'],
    ['SS304', 'stainless'], ['AISI 316L', 'stainless'], ['AISI 304L', 'stainless'], ['Stainless Steel 304', 'stainless'],
    ['Ti-6Al-4V', 'titanium'], ['AISI 1018', 'mild_steel'], ['AISI 4140', 'mild_steel'],
    ['Delrin', 'plastic'], ['HDPE', 'plastic'], ['A2 tool steel', 'tool_steel'],
  ])('%s -> %s', (grade, cls) => {
    expect(detectMaterialClass(grade)).toBe(cls);
  });
});

describe('regression: rotary broaching shares the part machine, so its setup is charged once', () => {
  it('the broaching line carries no second setup of the primary machine', () => {
    const result = computeMillingCostSummary(input({
      blankResult: billet(100, 50, 20), batchSize: 10,
      mhrRate: rate(600, { setupTimeHr: 0.5 }),
      featureOps: [{ name: 'Rough Mill', timeSec: 600, source: 'fixed' }],
      workbook: workbookFixture(),
      polygons: [{ kind: 'socket', sides: 6, acrossFlatsMm: 10, depthMm: 5, count: 1 }],
      rotaryBroach: realRotaryBroachReference(),
    }), mc('3_axis_mill'));
    const broach = result.processLines.find((l) => l.process === 'Rotary Broaching')!;
    expect(broach).toBeDefined();
    expect(broach.setupCost).toBe(0);
    expect(broach.runCost).toBeGreaterThan(0);
    // The one setup is on the primary line: 30 min / 10 x 600/h.
    expect(result.processLines.find((l) => l.process === '3 Axis Mill')!.setupCost).toBeCloseTo(30, 2);
    const setups = result.processLines.filter((l) => l.setupCost > 0 && l.machineName === 'Test VMC');
    expect(setups).toHaveLength(1);
  });
});

// ── End to end: inputs -> real calculators -> cost summary ──────────────────
const milled = (batchSize: number) => input({
  batchSize, blankResult: billet(104, 54, 24), volume: 40_000,
  holeCount: 6, holeGroups: [{ diameter_mm: 8, count: 4, depth_mm: 20 }, { diameter_mm: 5, count: 2, depth_mm: 12 }],
  threads: [{ size: 'M6', count: 2, depthMm: 10 }],
  tightestToleranceMm: 0.1, sharpEdgeLengthMm: 900, deburrLinearSpeedMmPerSec: 5,
  workbook: workbookFixture(),
  mhrRate: rate(600, { setupTimeHr: 0.5 }),
  inspectionRate: rate(450, { machineClass: 'cmm', setupTimeHr: 0.25, machineName: 'CMM' }),
  tappingRate: rate(600, { machineClass: 'tapping', hostMachineClass: '3_axis_mill' }),
  featureOps: [{ name: 'Rough Mill', timeSec: 420, source: 'fixed' }, { name: 'Finish Mill', timeSec: 180, source: 'fixed' }],
});

const turned = (batchSize: number) => input({
  batchSize, family: 'turned', maxLength: 80, maxWidth: 32, maxHeight: 32, volume: 50_000,
  holeCount: 1, holeGroups: [{ diameter_mm: 8, count: 1, depth_mm: 30 }],
  workbook: workbookFixture(), partoffTable: realPartoffTable(), sharpEdgeLengthMm: 400, deburrLinearSpeedMmPerSec: 5,
  mhrRate: rate(900, { machineClass: '2_axis_lathe', setupTimeHr: 0.5, maxSpindleRpm: 4000 }),
  inspectionRate: rate(450, { machineClass: 'cmm', setupTimeHr: 0.25, machineName: 'CMM' }),
  blankResult: { form: 'round_bar', sizeLabel: 'Ø40', barDiameterMm: 40, billetVolMm3: Math.PI * 20 ** 2 * 80, utilizationPct: 50, endAllowanceMm: 0.5 },
});

const cases: Array<[string, (b: number) => MachiningCostInput, (i: MachiningCostInput) => ReturnType<typeof computeMillingCostSummary>]> = [
  ['milled', milled, (i) => computeMillingCostSummary(i, mc('3_axis_mill'))],
  ['turned', turned, (i) => computeTurningCostSummary(i, mc('2_axis_lathe'))],
];

describe.each(cases)('%s part, inputs to cost summary', (_name, build, run) => {
  const summary = run(build(10));

  it('breakdown sums to the total and every figure is finite and non-negative', () => {
    expect(summary.processLines.length).toBeGreaterThan(2);
    for (const l of summary.processLines) {
      for (const v of [l.setupCost, l.runCost, l.totalCost, l.cycleTimeMin]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(l.totalCost).toBeCloseTo(l.setupCost + l.runCost, 2);
    }
    expect(summary.totalProcessCost).toBeCloseTo(summary.processLines.reduce((s, l) => s + l.totalCost, 0), 1);
    expect(summary.totalCost).toBeCloseTo(summary.materialCost + summary.totalProcessCost, 1);
    expect(summary.materialCost).toBeGreaterThan(0);
    expect(summary.totalProcessCost).toBeGreaterThan(0);
    expect(summary.materialRemoval!.utilizationPct).toBeGreaterThan(0);
    expect(summary.materialRemoval!.utilizationPct).toBeLessThanOrEqual(100);
    expect(JSON.stringify(summary)).not.toMatch(/NaN|Infinity/);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(run(build(10)))).toBe(JSON.stringify(summary));
  });

  it('never gets dearer as the batch grows; material is batch-independent', () => {
    const totals = [1, 10, 100, 1000].map((b) => run(build(b)));
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]!.totalCost).toBeLessThanOrEqual(totals[i - 1]!.totalCost + 0.01);
      expect(totals[i]!.materialCost).toBe(totals[0]!.materialCost);
    }
    expect(totals[0]!.totalCost).toBeGreaterThan(totals[3]!.totalCost);
  });
});
