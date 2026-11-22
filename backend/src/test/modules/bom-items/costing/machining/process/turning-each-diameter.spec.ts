// A turned part is turned one diameter at a time: each turned diameter the analysis recognised (a Ring) is roughed and finished from the
// bar on its own diameter and length (turned-diameters.ts), and the line's time is their sum. Every expected time below is worked out by
// hand from the stored Rough Turning and Finish Turning calculators' formulas:
//
//   Radial Stock  = (Bar Ø - Ring Ø) / 2
//   Rough Stock   = max(Radial Stock - min(Finish Depth of Cut, Radial Stock), 0)
//   Rough Passes  = round(Rough Stock / Rough Depth of Cut)
//   Time per pass = Ring length / (Cutting Speed * 1000 / (pi * Ring Ø) * Feed) * 60     [s]
//   Rough  = Rough Passes * Time per pass (rough speed and feed);  Finish = one pass (finish speed and feed)
//
// with the cutting data of the fixture below (depth 1.3 / 0.8 mm, speed 250.4 / 333.1 m/min, feed 0.3625 / 0.29 mm/rev, rough / finish).
import {
  computeTurningCostSummary,
  type MachiningCostInput,
  type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { calculatorInputSteps } from '../../../../../../modules/bom-items/costing/machining/process/machining-trace';
import { lineDataGap } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { realDrillingTable, realPartoffTable } from '../real-reference-tables';

import type { TurnedRing } from '../../../../../../modules/bom-items/costing/machining/process/turned-diameters';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { ProcessLineCost } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';

const CALCS = specAsCalculators();
const LATHE = '2_axis_bar_feed_lathe_with_sub_spindle';
const mc = (s: string) => s as MachineClassId;
const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);

// The stepped shaft: Ø14 in the middle, a Ø12 step at each end, 32 mm long.
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
/** The lathe's own lines that charge a setup. */
const setupCarriers = (lines: ProcessLineCost[]) => lines.filter((l) => l.machineClass === LATHE && l.setupCost > 0).map((l) => l.process);

describe('a stepped shaft from a Ø16 bar: each diameter is turned on its own radial stock', () => {
  const result = cost(shaft());
  const rough = lineOf(result.processLines, 'Rough Turning')!;
  const finish = lineOf(result.processLines, 'Finish Turning')!;

  it('rough turns the two Ø12 steps, one pass each; the Ø14 has no rough pass to take', () => {
    // Ø14: radial (16 - 14) / 2 = 1; rough stock 1 - 0.8 = 0.2; round(0.2 / 1.3) = 0 passes -> not rough turned.
    // Ø12: radial (16 - 12) / 2 = 2; rough stock 2 - 0.8 = 1.2; round(1.2 / 1.3) = 1 pass.
    //      spindle 250.4 * 1000 / (pi * 12) = 6642.07 rpm; feed 6642.07 * 0.3625 = 2407.75 mm/min.
    //      18 mm: 18 / 2407.75 * 60 = 0.4486 s;  5 mm: 5 / 2407.75 * 60 = 0.1246 s.
    // Line: 0.4486 + 0.1246 = 0.5731 s.
    expect(sec(rough)).toBeCloseTo(0.5731, 2);
    expect(rough.featureBreakdown).toEqual([
      { name: 'Rough Turning // Ring Ø12 x 18 mm', timeSec: expect.closeTo(0.4486, 4), featureType: 'Ring', count: 1, faceIds: [17] },
      { name: 'Rough Turning // Ring Ø12 x 5 mm', timeSec: expect.closeTo(0.1246, 4), featureType: 'Ring', count: 1, faceIds: [24] },
    ]);
    // 0.5731 s at 900 per hour = 0.14, with the lathe's setup: 4.64.
    expect(rough.runCost).toBe(0.14);
    expect(rough.totalCost).toBe(4.64);
  });

  it('finish turns all three, one pass each', () => {
    // Ø14 x 8:  spindle 333.1 * 1000 / (pi * 14) = 7573.50 rpm; feed 7573.50 * 0.29 = 2196.32 mm/min; 8 / 2196.32 * 60 = 0.2185 s.
    // Ø12:      spindle 333.1 * 1000 / (pi * 12) = 8835.75 rpm; feed 8835.75 * 0.29 = 2562.37 mm/min.
    //           18 / 2562.37 * 60 = 0.4215 s;  5 / 2562.37 * 60 = 0.1171 s.
    // Line: 0.2185 + 0.4215 + 0.1171 = 0.7571 s.
    expect(sec(finish)).toBeCloseTo(0.7571, 2);
    expect(finish.featureBreakdown).toEqual([
      { name: 'Finish Turning // Ring Ø14 x 8 mm', timeSec: expect.closeTo(0.2185, 4), featureType: 'Ring', count: 1, faceIds: [9] },
      { name: 'Finish Turning // Ring Ø12 x 18 mm', timeSec: expect.closeTo(0.4215, 4), featureType: 'Ring', count: 1, faceIds: [17] },
      { name: 'Finish Turning // Ring Ø12 x 5 mm', timeSec: expect.closeTo(0.1171, 4), featureType: 'Ring', count: 1, faceIds: [24] },
    ]);
    // 0.7571 s at 900 per hour = 0.19.
    expect(finish.totalCost).toBe(0.19);
  });

  it('the setup is on Rough Turning, once', () => {
    expect(setupCarriers(result.processLines)).toEqual(['Rough Turning']);
    expect(rough).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(finish).toMatchObject({ setupCost: 0, setupTimeMin: 0, setupTimeSource: 'none' });
  });

  it('neither turning line is a data gap: the lathe route is fully costed', () => {
    expect(lineDataGap(rough)).toBeNull();
    expect(lineDataGap(finish)).toBeNull();
    expect(rough.physicsGap).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('Turning not priced'))).toBe(false);
  });

  it('each line keeps one calculator and every Ring\'s run under the Ring\'s name, then their sum', () => {
    expect(rough.calculatorId).toBe('Machining - Rough Turning');
    expect(finish.calculatorId).toBe('Machining - Finish Turning');
    const trace = rough.calculationTrace!;
    expect([...new Set(trace.map((s) => s.group).filter(Boolean))]).toEqual(['Ring Ø12 x 18 mm', 'Ring Ø12 x 5 mm']);
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Rough Passes')).toMatchObject({ value: 1 });
    expect(trace.find((s) => s.fieldName === 'Rough Turning cycle time')).toMatchObject({ kind: 'calculated', value: 0.5731, unit: 's' });
    // The setup is still the last thing in the line's calculation.
    expect(trace.find((s) => s.fieldName === 'Setup time')).toMatchObject({ value: 30 });
    // Reopened, the calculator fills from the first Ring, whose inputs open that Ring's faces on the model.
    const first = calculatorInputSteps(trace);
    expect(first.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 12, ref: { kind: 'faces', label: 'Ring Ø12 x 18 mm', faceIds: [17] } });
    expect(first.find((s) => s.fieldName === 'Turned Length')).toMatchObject({ value: 18 });
    expect(first.find((s) => s.fieldName === 'Bar Diameter')).toMatchObject({ value: 16 });
  });

  it('the summary\'s turning minutes are the two lines\'', () => {
    expect(result.cycleTimes.laserMin).toBe(Math.round(((0.5731 + 0.7571) / 60) * 100) / 100);
  });
});

describe('the bar at the largest diameter: that diameter is left as supplied, the steps are still turned', () => {
  it('Ø14 bar, Ø12 steps: 1 mm of radial stock is one finish pass and no rough pass; the setup is on Finish Turning', () => {
    // Ø14: radial 0 -> as supplied, on neither line.
    // Ø12: radial (14 - 12) / 2 = 1; rough stock 1 - 0.8 = 0.2; round(0.2 / 1.3) = 0 passes -> no Rough Turning line at all.
    //      finish 18 / 2562.37 * 60 = 0.4215 s and 5 / 2562.37 * 60 = 0.1171 s: 0.5386 s.
    const { processLines, warnings } = cost(shaft({ blankResult: bar(14) }));
    expect(lineOf(processLines, 'Rough Turning')).toBeUndefined();
    const finish = lineOf(processLines, 'Finish Turning')!;
    expect(sec(finish)).toBeCloseTo(0.5386, 2);
    expect(finish.featureBreakdown!.map((f) => f.name)).toEqual(['Finish Turning // Ring Ø12 x 18 mm', 'Finish Turning // Ring Ø12 x 5 mm']);
    expect(setupCarriers(processLines)).toEqual(['Finish Turning']);
    expect(finish).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(finish.calculationTrace!.find((s) => s.fieldName === 'Setup time')).toMatchObject({ value: 30 });
    expect(lineDataGap(finish)).toBeNull();
    expect(warnings.some((w) => w.includes('Turning not priced') || w.includes('setup not charged'))).toBe(false);
  });

  it('Ø14 bar, a Ø10 step: 2 mm of radial stock is roughed, and the setup is back on Rough Turning', () => {
    // Ø10 x 20: radial (14 - 10) / 2 = 2; rough stock 1.2; 1 pass.
    //   rough  spindle 250.4 * 1000 / (pi * 10) = 7970.48 rpm; feed 2889.30 mm/min; 20 / 2889.30 * 60 = 0.4153 s.
    //   finish spindle 333.1 * 1000 / (pi * 10) = 10602.90 rpm; feed 3074.84 mm/min; 20 / 3074.84 * 60 = 0.3903 s.
    const rings: TurnedRing[] = [{ id: 'od_0', diameterMm: 14, lengthMm: 12, faceIds: [1] }, { id: 'od_1', diameterMm: 10, lengthMm: 20, faceIds: [2] }];
    const { processLines } = cost(shaft({ blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings } }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    const finish = lineOf(processLines, 'Finish Turning')!;
    expect(sec(rough)).toBeCloseTo(0.4153, 2);
    expect(sec(finish)).toBeCloseTo(0.3903, 2);
    expect(rough.featureBreakdown).toEqual([{ name: 'Rough Turning // Ring Ø10 x 20 mm', timeSec: expect.closeTo(0.4153, 4), featureType: 'Ring', count: 1, faceIds: [2] }]);
    // One Ring turned: its run is the line's calculation as it is, under the calculator's own field names.
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 10, source: 'CAD: turned outer diameter (Ring feature)' });
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
  });
});

describe('a part analysed without Ring features: one run on its fallback cylinder, as before', () => {
  // Ø20 x 100 from a Ø30 bar: radial 5; rough stock 4.2; round(4.2 / 1.3) = 3 passes.
  //   rough  spindle 250.4 * 1000 / (pi * 20) = 3985.24 rpm; feed 1444.65 mm/min; 100 / 1444.65 * 60 = 4.1533 s; x 3 = 12.4598 s.
  //   finish spindle 333.1 * 1000 / (pi * 20) = 5301.45 rpm; feed 1537.42 mm/min; 100 / 1537.42 * 60 = 3.9026 s.
  const fallback = {
    diameterMm: 20, lengthMm: 100,
    diameterSource: 'CAD: bounding-box cross-section (no turned-diameter feature recognised)',
    lengthSource: 'CAD: bounding-box length (no turned-diameter feature recognised)',
  };
  const input = (rings?: TurnedRing[]) => shaft({ maxLength: 100, maxWidth: 20, maxHeight: 20, blankResult: bar(30), turnedGeometry: { ...fallback, ...(rings ? { rings } : {}) } });

  it('roughs and finishes that cylinder, with no Ring rows and the calculators\' own field names', () => {
    const { processLines } = cost(input());
    const rough = lineOf(processLines, 'Rough Turning')!;
    const finish = lineOf(processLines, 'Finish Turning')!;
    expect(sec(rough)).toBeCloseTo(12.4598, 1);
    expect(sec(finish)).toBeCloseTo(3.9026, 1);
    expect(rough.featureBreakdown).toBeUndefined();
    expect(finish.featureBreakdown).toBeUndefined();
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 20, source: fallback.diameterSource });
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Turned Length')).toMatchObject({ value: 100, source: fallback.lengthSource });
    expect(rough.calculationTrace!.some((s) => s.group)).toBe(false);
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
  });

  it('an empty Ring list is the same part', () => {
    expect(cost(input([])).processLines).toEqual(cost(input()).processLines);
  });
});

describe('the lathe\'s setup when nothing is turned (the bar is the part\'s only diameter)', () => {
  const plain = (overrides: Partial<MachiningCostInput> = {}) => shaft({
    blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings: [{ id: 'od_0', diameterMm: 14, lengthMm: 32, faceIds: [9] }] }, ...overrides,
  });

  it('a drilled part: no turning line, the setup is on Drilling', () => {
    const { processLines, warnings } = cost(plain({ holeCount: 1, holeGroups: [{ diameter_mm: 4, count: 1, depth_mm: 10 }] }));
    expect(lineOf(processLines, 'Rough Turning')).toBeUndefined();
    expect(lineOf(processLines, 'Finish Turning')).toBeUndefined();
    const drilling = lineOf(processLines, 'Drilling')!;
    expect(drilling.cycleTimeMin).toBeGreaterThan(0);
    expect(setupCarriers(processLines)).toEqual(['Drilling']);
    expect(drilling).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(lineOf(processLines, 'Parting')).toMatchObject({ setupCost: 0, setupTimeSource: 'none' });
    expect(warnings.some((w) => w.includes('Turning not priced'))).toBe(false);
  });

  it('no holes: the setup is on Parting, the lathe\'s only cut', () => {
    const { processLines } = cost(plain());
    expect(processLines.filter((l) => l.machineClass === LATHE).map((l) => l.process)).toEqual(['Parting']);
    expect(setupCarriers(processLines)).toEqual(['Parting']);
    expect(lineDataGap(lineOf(processLines, 'Parting')!)).toBeNull();
  });

  it('cut off by a saw, with nothing for the lathe to do: no lathe line, no setup charged, and the quote says so', () => {
    const { processLines, warnings, totalProcessCost } = cost(plain({ stockCutOff: 'saw' }));
    expect(processLines.filter((l) => l.machineClass === LATHE)).toEqual([]);
    expect(warnings.some((w) => w.includes('setup not charged'))).toBe(true);
    expect(totalProcessCost).toBe(Math.round(processLines.reduce((s, l) => s + l.totalCost, 0) * 100) / 100);
  });
});

describe('turning that cannot be priced is still a gap line, with its reason and the setup', () => {
  it('no round bar to turn from', () => {
    const { processLines, warnings } = cost(shaft({ blankResult: { form: 'billet', sizeLabel: '16 x 16 x 34 billet', billetVolMm3: 16 * 16 * 34, utilizationPct: 40 } }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    expect(rough.cycleTimeMin).toBe(0);
    expect(rough.physicsGap).toMatchObject({ gapType: 'unsupported_operation', reason: expect.stringContaining('round-bar stock for this part') });
    expect(rough.confidence).toBe('unsupported');
    expect(rough.featureBreakdown).toBeUndefined();
    expect(lineDataGap(rough)?.reason).toContain('round-bar stock');
    expect(lineOf(processLines, 'Finish Turning')).toBeUndefined();
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
    expect(warnings.some((w) => w.includes('Turning not priced') && w.includes('round-bar stock'))).toBe(true);
  });

  it('no tblGeneralTurning data for the material', () => {
    const { processLines, warnings } = cost(shaft({ turningParams: null }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    expect(rough.cycleTimeMin).toBe(0);
    expect(rough.physicsGap).toMatchObject({ reason: expect.stringContaining('tblGeneralTurning cutting data') });
    expect(lineOf(processLines, 'Finish Turning')).toBeUndefined();
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
    expect(warnings.some((w) => w.includes('Turning not priced') && w.includes('tblGeneralTurning'))).toBe(true);
  });

  it('no calculator mapped for the operation', () => {
    const { ['Rough Turning']: _rough, ...withoutRough } = CALCS;
    const { processLines } = cost(shaft({ machiningCalculators: withoutRough }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    expect(rough.cycleTimeMin).toBe(0);
    expect(rough.physicsGap).toMatchObject({ reason: expect.stringContaining('a calculator for "Rough Turning"') });
    expect(sec(lineOf(processLines, 'Finish Turning'))).toBeCloseTo(0.7571, 2);
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
  });

  it('nothing to turn needs no cutting data: no gap', () => {
    const { processLines, warnings } = cost(shaft({ blankResult: bar(12), turningParams: null, turnedGeometry: { ...shaft().turnedGeometry!, diameterMm: 12, rings: [RINGS[1]!] } }));
    expect(lineOf(processLines, 'Rough Turning')).toBeUndefined();
    expect(warnings.some((w) => w.includes('Turning not priced'))).toBe(false);
  });
});

describe('a multi-spindle sharing the rough turning over its stations', () => {
  it('each Ring\'s row is its share, so the rows still add up to the line', () => {
    const { processLines } = cost(shaft({
      mhrRate: rate(900, { machineClass: LATHE, setupTimeHr: 0.5, numberSpindles: 6 }),
      roughTurningOpSplit: { shouldSplit: true, numberOfOperations: 2, thresholdRatio: 0.22, dataFound: true },
    }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    // 0.5731 s over 2 stations = 0.2866 s.
    expect(sec(rough)).toBeCloseTo(0.2866, 2);
    expect(rough.featureBreakdown!.reduce((s, f) => s + f.timeSec, 0)).toBeCloseTo(0.2866, 3);
  });
});
