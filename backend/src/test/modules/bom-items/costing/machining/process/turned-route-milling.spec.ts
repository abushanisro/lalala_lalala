// A turned part's keyways and slots on a lathe route: the turning engine prices the sequencer's milling operations on them as lines of
// the lathe (lathe-milling.ts). Before, it read none of them, so a closed keyway or a slot on a shaft cost nothing on every lathe route.
// Every expected time is worked out by hand from the stored calculators' formulas:
//
//   Rough Milling = (Removed Volume * 0.8 / Removal Rate + Removed Volume * 0.2 / (Removal Rate * 0.4)) * 60    [s]
//   Slot Milling  = Slots * 20                                                                                  [s]
//
// with a removal rate of 60 000 mm^3/min (the fixture's aluminium), on a lathe at 900 per hour (0.25 per second).
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
import { realDrillingTable, realPartoffTable } from '../real-reference-tables';

import type { TurnedRing } from '../../../../../../modules/bom-items/costing/machining/process/turned-diameters';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { ProcessLineCost } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';

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
// A radial slot: extents and removed volume, no length or width.
const SLOT = { id: 'Slot-radial_c1', feature_type: 'Slot', variant: 'radial', occurrences: [{ extents_mm: [8, 4, 3], material_removed_mm3: 480 }] };

/** The lathe's milling of these features: the real sequencer's operations on them (60 000 mm^3/min unless the rate is not on file). */
const millingOf = (features: unknown[], removalRate: number | null = 60000) =>
  latheMillingOps(buildOperationSequence(features, 'aluminum', 1.0, 'Aluminum, ANSI 6061', null, null, null, null, CALCS, null, removalRate, null));

// The stepped shaft of turning-each-diameter.spec.ts: Ø14 in the middle, a Ø12 step at each end, from a Ø16 bar.
const RINGS: TurnedRing[] = [
  { id: 'od_0', diameterMm: 14, lengthMm: 8, faceIds: [9] },
  { id: 'od_1', diameterMm: 12, lengthMm: 18, faceIds: [17] },
  { id: 'od_2', diameterMm: 12, lengthMm: 5, faceIds: [24] },
];
const bar = (diameterMm: number) => ({
  form: 'round_bar', sizeLabel: `Ø${diameterMm} round bar`, billetVolMm3: Math.PI * (diameterMm / 2) ** 2 * 33, utilizationPct: 60, barDiameterMm: diameterMm,
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
    mhrRate: rate(900, { machineClass: LATHE, setupTimeHr: 0.5 }),
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
    turningParams: {
      roughCutDepthMm: 1.3, roughCuttingSpeedMPerMin: 250.4, roughFeedMmPerRev: 0.3625,
      finishCutDepthMm: 0.8, finishCuttingSpeedMPerMin: 333.1, finishFeedMmPerRev: 0.29, dataFound: true,
    },
    drillingTable: realDrillingTable(),
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
  const keyway = lineOf(result.processLines, 'Rough Milling')!;

  it('is a Rough Milling line on the lathe, after its drilling and before the cut-off', () => {
    expect(latheLines(result.processLines)).toEqual(['Rough Turning', 'Finish Turning', 'Drilling', 'Rough Milling', 'Parting']);
    expect(keyway).toMatchObject({ machineClass: LATHE, machineName: 'M', hourlyRate: 900 });
  });

  it('is timed by the Rough Milling calculator on the volume the keyway removes', () => {
    // 107.91 * 0.8 / 60000 = 0.0014388 min; 107.91 * 0.2 / (60000 * 0.4) = 0.00089925 min; sum 0.00233805 min = 0.1403 s.
    // (A line keeps its cycle to four decimals of a minute: 0.0023 min = 0.138 s.)
    expect(sec(keyway)).toBeCloseTo(0.1403, 2);
    // 0.1403 s at 0.25 per second = 0.035 -> 0.04.
    expect(keyway.runCost).toBe(0.04);
    expect(keyway.totalCost).toBe(0.04);
    expect(keyway.calculatorId).toBe('Machining - Rough Milling');
    expect(calculatorInputSteps(keyway.calculationTrace!).find((s) => s.fieldName === 'Removed Volume')).toMatchObject({ value: 107.91 });
    expect(keyway.calculationTrace!.find((s) => s.fieldName === 'Cycle Time')).toMatchObject({ kind: 'calculated', value: 0.1403 });
    expect(keyway.lookupMatches).toEqual({ 'Material Removal Rate': { table: 'tblMillingRemovalRate', row: { MaterialClass: 'aluminum' } } });
  });

  it('charges no second setup: the lathe\'s setup stays on Rough Turning', () => {
    expect(setupCarriers(result.processLines)).toEqual(['Rough Turning']);
    expect(keyway).toMatchObject({ setupCost: 0, setupTimeMin: 0, setupTimeSource: 'none' });
    expect(keyway.calculationTrace!.some((s) => s.fieldName === 'Setup time')).toBe(false);
  });

  it('names the keyway as its row, so the Process tree lists it under the line and lights its faces', () => {
    expect(keyway.featureBreakdown).toEqual([
      { name: 'Rough Milling // Keyway', timeSec: expect.closeTo(0.1403, 4), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] },
    ]);
  });

  it('is fully costed, and adds exactly its own cost and time to the route', () => {
    expect(lineDataGap(keyway)).toBeNull();
    expect(keyway.physicsGap).toBeUndefined();
    expect(result.totalProcessCost).toBe(Math.round((withoutKeyway.totalProcessCost + 0.04) * 100) / 100);
    expect(result.processLines.filter((l) => l.process !== 'Rough Milling')).toEqual(withoutKeyway.processLines);
    expect(result.warnings).toEqual(withoutKeyway.warnings);
  });
});

describe('the lathe\'s setup when the milling is its only work', () => {
  // The bar is the part's only diameter and a saw cuts the piece off: nothing is turned, drilled or parted.
  const plain = (overrides: Partial<MachiningCostInput> = {}) => shaft({
    blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings: [{ id: 'od_0', diameterMm: 14, lengthMm: 32, faceIds: [9] }] },
    stockCutOff: 'saw', ...overrides,
  });

  it('the keyway\'s Rough Milling carries the setup, once', () => {
    const { processLines, warnings } = cost(plain({ latheMilling: millingOf([KEYWAY]) }));
    expect(latheLines(processLines)).toEqual(['Rough Milling']);
    const keyway = lineOf(processLines, 'Rough Milling')!;
    // The setup 4.50 and the keyway's 0.04.
    expect(keyway).toMatchObject({ setupCost: SETUP_COST, runCost: 0.04, totalCost: 4.54, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(keyway.calculationTrace!.find((s) => s.fieldName === 'Setup time')).toMatchObject({ value: 30 });
    expect(warnings.some((w) => w.includes('setup not charged'))).toBe(false);
  });

  it('a slot: the setup is on the first of its two lines only', () => {
    const { processLines } = cost(plain({ latheMilling: millingOf([SLOT]) }));
    expect(latheLines(processLines)).toEqual(['Rough Milling', 'Slot Milling']);
    expect(setupCarriers(processLines)).toEqual(['Rough Milling']);
  });
});

describe('a slot on a turned part: roughed, then finished, each a line of the lathe', () => {
  const result = cost(shaft({ latheMilling: millingOf([SLOT]) }));
  const rough = lineOf(result.processLines, 'Rough Milling')!;
  const slot = lineOf(result.processLines, 'Slot Milling')!;

  it('Rough Milling of the slot\'s volume, then Slot Milling of the slot', () => {
    expect(latheLines(result.processLines)).toEqual(['Rough Turning', 'Finish Turning', 'Rough Milling', 'Slot Milling', 'Parting']);
    // Rough: 480 * 0.8 / 60000 = 0.0064 min; 480 * 0.2 / 24000 = 0.004 min; sum 0.0104 min = 0.624 s; at 0.25 per second = 0.156 -> 0.16.
    expect(sec(rough)).toBeCloseTo(0.624, 2);
    expect(rough.totalCost).toBe(0.16);
    // Slot Milling: 1 slot * 20 s = 20 s; at 0.25 per second = 5.00.
    expect(sec(slot)).toBeCloseTo(20, 2);
    expect(slot.totalCost).toBe(5);
    expect(slot.calculatorId).toBe('Machining - Slot Milling');
  });

  it('both lines name the slot, and neither charges a setup', () => {
    expect(rough.featureBreakdown).toEqual([{ name: 'Rough Milling // Slot', timeSec: expect.closeTo(0.624, 4), featureType: 'Slot', count: 1, featureIds: ['Slot-radial_c1'] }]);
    expect(slot.featureBreakdown).toEqual([{ name: 'Slot Milling // Slot', timeSec: 20, featureType: 'Slot', count: 1, featureIds: ['Slot-radial_c1'] }]);
    expect(setupCarriers(result.processLines)).toEqual(['Rough Turning']);
    expect(lineDataGap(rough)).toBeNull();
    expect(lineDataGap(slot)).toBeNull();
  });

  it('a keyway and a slot share the Rough Milling line: their times add up, each under its own name', () => {
    // 0.1403 s (keyway) + 0.624 s (slot) = 0.7643 s; at 0.25 per second = 0.19.
    const both = lineOf(cost(shaft({ latheMilling: millingOf([KEYWAY, SLOT]) })).processLines, 'Rough Milling')!;
    expect(sec(both)).toBeCloseTo(0.7643, 2);
    expect(both.totalCost).toBe(0.19);
    expect(both.featureBreakdown!.map((f) => [f.name, f.featureIds])).toEqual([['Rough Milling // Keyway', ['Keyway-default_c1']], ['Rough Milling // Slot', ['Slot-radial_c1']]]);
    expect(both.calculationTrace!.find((s) => s.fieldName === 'Rough Milling cycle time')).toMatchObject({ kind: 'calculated', value: 0.7643, unit: 's' });
  });
});

describe('an operation the sequencer could not time is a named gap on its line, never a silent zero', () => {
  // No milling removal rate on file for the material: Rough Milling cannot be timed. Slot Milling needs none.
  const result = cost(shaft({ latheMilling: millingOf([KEYWAY, SLOT], null) }));
  const rough = lineOf(result.processLines, 'Rough Milling')!;

  it('the Rough Milling line has no time and says what it lacks', () => {
    expect(rough.cycleTimeMin).toBe(0);
    expect(rough.totalCost).toBe(0);
    expect(rough.physicsGap).toMatchObject({
      gapType: 'unsupported_operation', process: 'Rough Milling', machineClass: LATHE,
      reason: 'Not priced — missing real input: Rough Milling: Material Removal Rate (Keyway); Rough Milling: Material Removal Rate (Slot).',
    });
    expect(rough.confidence).toBe('unsupported');
    expect(rough.featureBreakdown).toBeUndefined();
  });

  it('the route is not fully costed, and the operation that can be timed still is', () => {
    expect(lineDataGap(rough)?.reason).toContain('Material Removal Rate');
    const slot = lineOf(result.processLines, 'Slot Milling')!;
    expect(sec(slot)).toBeCloseTo(20, 2);
    expect(lineDataGap(slot)).toBeNull();
    expect(setupCarriers(result.processLines)).toEqual(['Rough Turning']);
  });
});

describe('a part with no keyway or slot is costed as before', () => {
  it('no milling line, and every line and total is what it was without the input', () => {
    const before = cost(shaft());
    expect(latheLines(before.processLines)).toEqual(['Rough Turning', 'Finish Turning', 'Parting']);
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
