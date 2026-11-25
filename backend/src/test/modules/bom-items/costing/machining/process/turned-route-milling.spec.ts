// A turned part's keyways and slots on a lathe route: the turning engine prices the sequencer's milling operations on them as lines of
// the lathe (lathe-milling.ts). Before, it read none of them, so a closed keyway or a slot on a shaft cost nothing on every lathe route.
// Every expected time is worked out by hand from the stored calculators' formulas:
//
//   Obround Slot Milling (a keyway, cut by an end mill of its width in passes between its two end centres):
//     Spindle Speed = min(10 000, Cutting Speed * 1000 / (pi * Keyway Width))                                   [rpm]
//     Feed Rate     = Spindle Speed * Teeth * Feed per Tooth per Diameter * Keyway Width                        [mm/min]
//     Passes        = ceil(Keyway Depth / (0.2 * Keyway Width))
//     Path per Pass = max(Keyway Length - Keyway Width, 0) + Keyway Depth / Passes                              [mm]
//     Cycle Time    = Keyways * Passes * Path per Pass / Feed Rate * 60                                         [s]
//   Slot Milling  (the workbook's Slot Milling sheet) = Slots * ceil((Slot Length + 10 + D) / (fz * Teeth * n) * Depth Passes * 60)    [s]
//   Rough Milling (the workbook's End Milling sheet)  = Cuts * ceil((Cut Length + 10 + D / 2) / (fz * Teeth * n) * Width x Depth Passes * 60)  [s]
//
// with the fixture's aluminium (the workbook's 450 m/min and 0.15 mm/tooth; the tblMillingFinishing end mill, 10 mm and 3 teeth; a
// keyway's run at 183 m/min with a feed per tooth of 0.008 of its diameter), on a lathe at 900 per hour (0.25 per second) whose live
// tool turns at most 10 000 rpm. An end mill's wear is the workbook's Rs 1337.5 over 1000 parts, Rs 1.3375 a run, at the test's Rs 84 to
// the dollar.
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildOperationSequence } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import {
  computeMillingCostSummary,
  computeTurningCostSummary,
  type MachiningCostInput,
  type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { latheMillingOps } from '../../../../../../modules/bom-items/costing/machining/process/lathe-milling';
import { calculatorInputSteps } from '../../../../../../modules/bom-items/costing/machining/process/machining-trace';
import { lineDataGap } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { realPartoffTable } from '../real-reference-tables';

import type { TurnedRing } from '../../../../../../modules/bom-items/costing/machining/process/turned-diameters';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { ProcessLineCost } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { TEST_INR_PER_USD, workbookFixture } from '../workbook-fixture';
import type { MachiningWorkbookInput } from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';

const CALCS = specAsCalculators();
const LATHE = '3_axis_bar_feed_lathe_with_sub_spindle';
const mc = (s: string) => s as MachineClassId;
const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);

// Lead Screw side shaft: the closed keyway on its turned diameter, as feature_graph_v2 stores it.
const KEYWAY = {
  id: 'Keyway-default_c1', feature_type: 'Keyway', variant: 'default',
  occurrences: [{
    face_ids: [13, 14, 15, 25, 26], material_removed_mm3: 107.91, depth_mm: 2.951, walled_fraction: 1.0, width_confined: true,
    length_mm: 9.971, width_mm: 4.0, extents_mm: [10.005, 4.0, 2.951],
  }],
};
// A radial slot, 8 x 4 x 3 mm: its floor's box and measured depth. Cut by a 4 mm end mill (its width): 450 m/min holds the live tool's
// 10 000 rpm; 0.15 x 3 x 10 000 = 4500 mm/min; depth of cut 2 mm, 2 passes of 8 + 10 + 4 = 22 mm: 44 / 4500 = 0.00978 min = 0.59 s -> 1 s
// (plunging, 4 plunges of 13 mm, is no quicker). At 0.25 per second = 0.25, and the end mill's wear.
const SLOT = { id: 'Slot-radial_c1', feature_type: 'Slot', variant: 'radial', occurrences: [{ extents_mm: [8, 4, 0], depth_mm: 3, material_removed_mm3: 96 }] };
const SLOT_SEC = 1;
const END_MILL = 1.3375 / TEST_INR_PER_USD;

const FINISHING = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
// The keyway, 9.971 x 4 x 2.951 mm: 183 000 / (pi x 4) = 14 563 rpm, held to 10 000; feed 10 000 x 3 x 0.008 x 4 = 960 mm/min;
// ceil(2.951 / 0.8) = 4 passes of 5.971 + 2.951 / 4 = 6.70875 mm; 4 x 6.70875 / 960 x 60 = 1.6772 s. At 0.25 per second = 0.4193,
// not rounded to cents.
const KEYWAY_SEC = 1.6772;
const KEYWAY_COST = (4 * 6.70875 / 960) * 60 * 0.25;

/** The lathe's milling of these features: the real sequencer's operations on them (the fixture's cutter row and workbook unless one is not on file). */
const millingOf = (features: unknown[], finishing: typeof FINISHING | null = FINISHING, workbook: MachiningWorkbookInput = workbookFixture()) =>
  latheMillingOps(buildOperationSequence(features, { matClass: 'aluminum', machinabilityFactor: 1.0, materialGrade: 'Aluminum, ANSI 6061', calculators: CALCS, removalRateMm3PerMin: 60000, finishing, workbook }));

// The stepped shaft of turning-each-diameter.spec.ts: Ø14 in the middle, a Ø12 step at each end, from a Ø16 bar.
const RINGS: TurnedRing[] = [
  { id: 'od_0', diameterMm: 14, lengthMm: 8, faceIds: [9] },
  { id: 'od_1', diameterMm: 12, lengthMm: 18, faceIds: [17] },
  { id: 'od_2', diameterMm: 12, lengthMm: 5, faceIds: [24] },
];
const bar = (diameterMm: number) => ({
  form: 'round_bar', sizeLabel: `Ø${diameterMm} round bar`, billetVolMm3: Math.PI * (diameterMm / 2) ** 2 * 33, utilizationPct: 60, barDiameterMm: diameterMm,
  endAllowanceMm: 0.5,
});

// The lathe: 900 per hour, a 30 min setup over a batch of 100 = 0.3 min per part = 4.50.
const SETUP_COST = 4.5;
function shaft(overrides: Partial<MachiningCostInput> = {}): MachiningCostInput {
  return {
    volume: 4000, surfaceArea: 1500, maxLength: 32, maxWidth: 14, maxHeight: 14,
    holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 100, family: 'turned', finishedWeightKg: 0.011,
    // The Haas DS-30's 4000 rpm spindle (migration 1136).
    mhrRate: rate(900, { machineClass: LATHE, setupTimeHr: 0.5, maxSpindleRpm: 4000, liveToolingMaxRpm: 10000 }),
    tappingRate: rate(900, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null,
    machiningCalculators: CALCS,
    turnedGeometry: {
      diameterMm: 14, lengthMm: 32,
      diameterSource: 'CAD: largest turned outer diameter (Ring feature)',
      lengthSource: 'CAD: bounding-box extent along the turning axis',
      rings: RINGS,
    },
    blankResult: bar(16),
    workbook: workbookFixture(),
    partoffTable: realPartoffTable(),
    ...overrides,
  };
}

const cost = (input: MachiningCostInput) => computeTurningCostSummary(input, mc(LATHE));
const lineOf = (lines: ProcessLineCost[], process: string) => lines.find((l) => l.process === process);
const sec = (l: ProcessLineCost | undefined) => (l ? l.cycleTimeMin * 60 : null);
const latheLines = (lines: ProcessLineCost[]) => lines.filter((l) => l.machineClass === LATHE).map((l) => l.process);
/** The lathe's own lines that charge a setup. */
const setupCarriers = (lines: ProcessLineCost[]) => lines.filter((l) => l.machineClass === LATHE && l.setupCost > 0).map((l) => l.process);

describe('a closed keyway on a turned shaft: milled on the lathe, as a line of the lathe', () => {
  const withoutKeyway = cost(shaft({ holeCount: 2, holeGroups: [{ diameter_mm: 2.529, count: 2, depth_mm: 12 }] }));
  const result = cost(shaft({ holeCount: 2, holeGroups: [{ diameter_mm: 2.529, count: 2, depth_mm: 12 }], latheMilling: millingOf([KEYWAY]) }));
  const keyway = lineOf(result.processLines, 'Obround Slot Milling')!;

  it('is an Obround Slot Milling line on the lathe, after its drilling and before the cut-off', () => {
    expect(latheLines(result.processLines)).toEqual(['End Machining', 'Rough Turning', 'Finish Turning', 'Drilling', 'Obround Slot Milling', 'Parting']);
    expect(keyway).toMatchObject({ machineClass: LATHE, machineName: 'M', hourlyRate: 900 });
  });

  it('is timed by the Obround Slot Milling calculator on the keyway\'s length, width and depth, not on its volume at the bulk removal rate', () => {
    // (A line keeps its cycle to four decimals of a minute: 0.028 min = 1.68 s.)
    expect(sec(keyway)).toBeCloseTo(KEYWAY_SEC, 2);
    expect(keyway.runCost).toBeCloseTo(KEYWAY_COST, 10);
    expect(keyway.totalCost).toBeCloseTo(KEYWAY_COST, 10);
    expect(keyway.calculatorId).toBe('Machining - Obround Slot Milling');
    const inputs = calculatorInputSteps(keyway.calculationTrace!);
    expect(inputs.find((s) => s.fieldName === 'Keyway Length')).toMatchObject({ value: 9.971, source: 'CAD: keyway length' });
    expect(inputs.find((s) => s.fieldName === 'Keyway Width')).toMatchObject({ value: 4 });
    expect(inputs.find((s) => s.fieldName === 'Keyway Depth')).toMatchObject({ value: 2.951 });
    expect(inputs.some((s) => s.fieldName === 'Removed Volume' || s.fieldName === 'Material Removal Rate')).toBe(false);
    const calculated = (field: string) => keyway.calculationTrace!.find((s) => s.fieldName === field);
    expect(calculated('Spindle Speed')).toMatchObject({ kind: 'calculated', value: 10000 });
    expect(calculated('Feed Rate')).toMatchObject({ kind: 'calculated', value: 960 });
    expect(calculated('Passes')).toMatchObject({ kind: 'calculated', value: 4 });
    expect(calculated('Path per Pass')).toMatchObject({ kind: 'calculated', value: 6.7088 });
    expect(calculated('Cycle Time')).toMatchObject({ kind: 'calculated', value: KEYWAY_SEC });
    const row = { table: 'tblMillingFinishing', row: { MaterialClass: 'aluminum' } };
    expect(keyway.lookupMatches).toEqual({ 'Teeth': row, 'Cutting Speed': row, 'Feed per Tooth per Diameter': row });
  });

  it('shows the depth of a pass as the engine\'s own value, not the reference data\'s', () => {
    expect(keyway.calculationTrace!.find((s) => s.fieldName === 'Slotting Depth Ratio')).toMatchObject({
      kind: 'input', value: 0.2, source: expect.stringMatching(/^The engine's own value: the reference data has none\./),
      ref: { kind: 'calculatorField', calculator: 'Machining - Obround Slot Milling', field: 'Slotting Depth Ratio' },
    });
  });

  it('charges no second setup: the lathe\'s setup stays on its first cut, the facing', () => {
    expect(setupCarriers(result.processLines)).toEqual(['End Machining']);
    expect(keyway).toMatchObject({ setupCost: 0, setupTimeMin: 0, setupTimeSource: 'none' });
    expect(keyway.calculationTrace!.some((s) => s.fieldName === 'Setup time')).toBe(false);
  });

  it('names the keyway as its row, so the Process tree lists it under the line and lights its faces', () => {
    expect(keyway.featureBreakdown).toEqual([
      { name: 'Obround Slot Milling // Keyway', timeSec: expect.closeTo(KEYWAY_SEC, 4), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] },
    ]);
  });

  it('is fully costed, and adds exactly its own cost and time to the route', () => {
    expect(lineDataGap(keyway)).toBeNull();
    expect(keyway.physicsGap).toBeUndefined();
    expect(result.totalProcessCost).toBeCloseTo(withoutKeyway.totalProcessCost + KEYWAY_COST, 10);
    expect(result.processLines.filter((l) => l.process !== 'Obround Slot Milling')).toEqual(withoutKeyway.processLines);
    expect(result.warnings).toEqual(withoutKeyway.warnings);
  });
});

describe('the lathe\'s setup when the milling is its only work', () => {
  // The bar is the part's only diameter and a saw cuts the piece off: nothing is turned, drilled or parted.
  const plain = (overrides: Partial<MachiningCostInput> = {}) => shaft({
    blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings: [{ id: 'od_0', diameterMm: 14, lengthMm: 32, faceIds: [9] }] },
    stockCutOff: 'saw', ...overrides,
  });

  it('the sawn piece is faced first, which carries the setup once; the keyway charges none', () => {
    const { processLines, warnings } = cost(plain({ latheMilling: millingOf([KEYWAY]) }));
    expect(latheLines(processLines)).toEqual(['End Machining', 'Obround Slot Milling']);
    expect(setupCarriers(processLines)).toEqual(['End Machining']);
    expect(lineOf(processLines, 'End Machining')!.calculationTrace!.find((s) => s.fieldName === 'Setup time')).toMatchObject({ value: 30 });
    const keyway = lineOf(processLines, 'Obround Slot Milling')!;
    expect(keyway).toMatchObject({ setupCost: 0, setupTimeSource: 'none' });
    expect(keyway.totalCost).toBeCloseTo(KEYWAY_COST, 10);
    expect(warnings.some((w) => w.includes('setup not charged'))).toBe(false);
  });

  it('a slot: its line charges no setup, the facing does', () => {
    const { processLines } = cost(plain({ latheMilling: millingOf([SLOT]) }));
    expect(latheLines(processLines)).toEqual(['End Machining', 'Slot Milling']);
    expect(setupCarriers(processLines)).toEqual(['End Machining']);
  });
});

describe('a slot on a turned part: cut by Slot Milling, a line of the lathe', () => {
  const result = cost(shaft({ latheMilling: millingOf([SLOT]) }));
  const slot = lineOf(result.processLines, 'Slot Milling')!;

  it('one Slot Milling line, the workbook\'s Slot Milling sheet on the slot\'s length, width and depth: no separate roughing of its volume', () => {
    expect(latheLines(result.processLines)).toEqual(['End Machining', 'Rough Turning', 'Finish Turning', 'Slot Milling', 'Parting']);
    expect(sec(slot)).toBeCloseTo(SLOT_SEC, 2);
    expect(slot.runCost).toBeCloseTo(0.25 + END_MILL, 10);
    // The end mill's wear: Rs 1.3375 a part, at Rs 84 to the dollar.
    expect(slot.otherCostPerPart).toBeCloseTo(END_MILL, 10);
    expect(slot.totalCost).toBeCloseTo(0.25 + END_MILL, 10);
    expect(slot.calculatorId).toBe('Machining - Slot Milling');
  });

  it('the line names the slot, and charges no setup', () => {
    expect(slot.featureBreakdown).toEqual([{ name: 'Slot Milling // Slot', timeSec: SLOT_SEC, featureType: 'Slot', count: 1, featureIds: ['Slot-radial_c1'] }]);
    expect(setupCarriers(result.processLines)).toEqual(['End Machining']);
    expect(lineDataGap(slot)).toBeNull();
  });

  it('a keyway beside the slot is its own line: the slot\'s line is what it is without it', () => {
    const both = cost(shaft({ latheMilling: millingOf([KEYWAY, SLOT]) }));
    expect(latheLines(both.processLines)).toEqual(['End Machining', 'Rough Turning', 'Finish Turning', 'Obround Slot Milling', 'Slot Milling', 'Parting']);
    expect(both.processLines.filter((l) => l.process !== 'Obround Slot Milling')).toEqual(result.processLines);
    const keyway = lineOf(both.processLines, 'Obround Slot Milling')!;
    expect(sec(keyway)).toBeCloseTo(KEYWAY_SEC, 2);
    expect(keyway.totalCost).toBeCloseTo(KEYWAY_COST, 10);
    expect(keyway.featureBreakdown!.map((f) => [f.name, f.featureIds])).toEqual([['Obround Slot Milling // Keyway', ['Keyway-default_c1']]]);
  });
});

describe('flats on a turned part: roughed on the lathe, as a line of the lathe', () => {
  // Two wrench flats, as the CAD engine stores them: 20 mm long, 10.583 mm across and 2 mm deep. The 10 mm end mill: one width pass, one
  // depth pass; (20 + 10 + 5) / 4500 = 0.00778 min = 0.47 s -> 1 s a flat, 2 s for the two; at 0.25 per second = 0.50, and the end mill's
  // wear (one run for the two).
  const FLATS = {
    id: 'Flat-default_c2', feature_type: 'Flat', variant: 'default',
    occurrences: [4, 8].map((face) => ({ face_ids: [face], material_removed_mm3: 290.12, depth_mm: 2, length_mm: 20, width_mm: 10.583, diameter_mm: 16 })),
  };
  const FLATS_SEC = 2;
  const without = cost(shaft());
  const result = cost(shaft({ latheMilling: millingOf([FLATS]) }));
  const rough = lineOf(result.processLines, 'Rough Milling')!;

  it('is a Rough Milling line on the lathe, after the turning and before the cut-off', () => {
    expect(latheLines(result.processLines)).toEqual(['End Machining', 'Rough Turning', 'Finish Turning', 'Rough Milling', 'Parting']);
    expect(rough).toMatchObject({ machineClass: LATHE, machineName: 'M', hourlyRate: 900, setupCost: 0 });
  });

  it('is timed by the Rough Milling calculator (the workbook\'s End Milling sheet) on the flats\' size, and adds exactly its own cost to the route', () => {
    expect(sec(rough)).toBeCloseTo(FLATS_SEC, 2);
    expect(rough.calculatorId).toBe('Machining - Rough Milling');
    expect(calculatorInputSteps(rough.calculationTrace!).find((s) => s.fieldName === 'Cut Length')).toMatchObject({ value: 20 });
    expect(rough.runCost).toBeCloseTo(FLATS_SEC * 0.25 + END_MILL, 10);
    expect(lineDataGap(rough)).toBeNull();
    expect(result.totalProcessCost).toBeCloseTo(without.totalProcessCost + FLATS_SEC * 0.25 + END_MILL, 10);
    expect(result.processLines.filter((l) => l.process !== 'Rough Milling')).toEqual(without.processLines);
  });

  it('names the flats as its row, so the Process tree lists them under the line and lights their faces', () => {
    expect(rough.featureBreakdown).toEqual([
      { name: 'Rough Milling // Flat ×2', timeSec: FLATS_SEC, featureType: 'Flat', count: 2, featureIds: ['Flat-default_c2'] },
    ]);
  });

  it('a flat with no CAD size is the line\'s named gap, never a free flat', () => {
    const unmeasured = { ...FLATS, occurrences: [{ ...FLATS.occurrences[0], length_mm: 0 }] };
    const line = lineOf(cost(shaft({ latheMilling: millingOf([unmeasured]) })).processLines, 'Rough Milling')!;
    expect(line.totalCost).toBe(0);
    expect(lineDataGap(line)?.reason).toContain('the CAD length, width and depth of the flat');
  });
});

describe('an operation the sequencer could not time is a named gap on its line, never a silent zero', () => {
  // The workbook's milling conditions were not read: the slot's Slot Milling has no cutting speed or feed. The keyway needs none.
  const result = cost(shaft({ latheMilling: millingOf([KEYWAY, SLOT], FINISHING, workbookFixture({ tables: {} })) }));
  const slot = lineOf(result.processLines, 'Slot Milling')!;

  it('the Slot Milling line has no time and says what it lacks', () => {
    expect(slot.cycleTimeMin).toBe(0);
    expect(slot.totalCost).toBe(0);
    expect(slot.physicsGap).toMatchObject({ gapType: 'unsupported_operation', process: 'Slot Milling', machineClass: LATHE });
    expect((slot.physicsGap as { reason: string }).reason).toContain('tblMillingConditions');
    expect(slot.confidence).toBe('unsupported');
    expect(slot.featureBreakdown).toBeUndefined();
  });

  it('the route is not fully costed, and the operations that can be timed still are', () => {
    expect(lineDataGap(slot)?.reason).toContain('tblMillingConditions');
    const keyway = lineOf(result.processLines, 'Obround Slot Milling')!;
    expect(sec(keyway)).toBeCloseTo(KEYWAY_SEC, 2);
    expect(lineDataGap(keyway)).toBeNull();
    expect(setupCarriers(result.processLines)).toEqual(['End Machining']);
  });

  it('a keyway with no cutter data for the material is the gap, on its own line', () => {
    const keyway = lineOf(cost(shaft({ latheMilling: millingOf([KEYWAY], null) })).processLines, 'Obround Slot Milling')!;
    expect(keyway.cycleTimeMin).toBe(0);
    expect(keyway.totalCost).toBe(0);
    expect(keyway.physicsGap).toMatchObject({
      gapType: 'unsupported_operation', process: 'Obround Slot Milling', machineClass: LATHE,
      reason: 'Not priced — missing real input: Obround Slot Milling: Teeth, Cutting Speed, Feed per Tooth per Diameter.',
    });
    expect(keyway.featureBreakdown).toBeUndefined();
  });

  it('a keyway the CAD gives no width is the gap, named by the measurement', () => {
    const unmeasured = { ...KEYWAY, occurrences: [{ ...KEYWAY.occurrences[0], width_mm: null }] };
    const keyway = lineOf(cost(shaft({ latheMilling: millingOf([unmeasured]) })).processLines, 'Obround Slot Milling')!;
    expect(keyway.totalCost).toBe(0);
    expect((keyway.physicsGap as { reason?: string }).reason).toBe('Not priced — missing real input: the CAD width of the keyway.');
    expect(lineDataGap(keyway)?.reason).toContain('the CAD width of the keyway');
  });
});

describe('a part with no keyway or slot is costed as before', () => {
  it('no milling line, and every line and total is what it was without the input', () => {
    const before = cost(shaft());
    expect(latheLines(before.processLines)).toEqual(['End Machining', 'Rough Turning', 'Finish Turning', 'Parting']);
    expect(cost(shaft({ latheMilling: [] }))).toEqual(before);
    expect(cost(shaft({ latheMilling: millingOf([{ id: 'Ring-outer_diameter_c1', feature_type: 'Ring', variant: 'outer_diameter', occurrences: [{ material_removed_mm3: 900 }] }]) }))).toEqual(before);
  });
});

describe('a mill does not read the lathe\'s milling: a milled part is costed from its own operation list', () => {
  it('the milling engine gives the same quote with and without it', () => {
    const milled = (overrides: Partial<MachiningCostInput> = {}) => computeMillingCostSummary(
      shaft({ family: 'milled', mhrRate: rate(900, { machineClass: '3_axis_mill', setupTimeHr: 0.5 }), ...overrides }), mc('3_axis_mill'),
    );
    expect(milled({ latheMilling: millingOf([KEYWAY, SLOT]) })).toEqual(milled());
  });
});

// The sequencer plans the keyway's calculator run before any machine is chosen; the lathe times it on its own driven-tool spindle.
describe('the keyway is timed on the lathe\'s own live-tool spindle (timeOperations)', () => {
  const at = (liveToolingMaxRpm: number | null) => lineOf(cost(shaft({
    mhrRate: rate(900, { machineClass: LATHE, setupTimeHr: 0.5, maxSpindleRpm: 4000, liveToolingMaxRpm }),
    latheMilling: millingOf([KEYWAY]),
  })).processLines, 'Obround Slot Milling')!;

  it('a 5000 rpm live tool: the cutter turns at half the speed of a 10 000 rpm one, so the keyway takes twice as long', () => {
    // 4 x 6.70875 / (5000 x 3 x 0.008 x 4 = 480 mm/min) x 60 = 3.3545 s.
    const keyway = at(5000);
    expect(keyway.calculationTrace!.find((s) => s.fieldName === 'Max Spindle Speed')).toMatchObject({ value: 5000, source: expect.stringContaining('live_tooling_speed_rpm') });
    expect(sec(keyway)).toBeCloseTo(2 * KEYWAY_SEC, 2);
  });

  it('a live tool faster than the cutter needs (20 000 rpm): 183 000 / (pi x 4) = 14 563 rpm, the cutting speed\'s own', () => {
    // feed 14 563.4 x 0.096 = 1398.1 mm/min; 4 x 6.70875 / 1398.1 x 60 = 1.1517 s.
    expect(sec(at(20000))).toBeCloseTo(1.1517, 2);
  });

  it('a lathe with no live-tool speed on file cannot time the keyway: a named gap, never a stand-in 10 000 rpm', () => {
    // Every live-tool lathe class on file has its speed (migration 1136); a record without one says so rather than borrow a speed.
    const keyway = at(null);
    expect(sec(keyway)).toBe(0);
    expect(keyway.physicsGap).toBeDefined();
  });
});
