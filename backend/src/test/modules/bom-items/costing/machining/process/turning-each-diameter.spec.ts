// A turned part is turned one diameter at a time: each turned diameter the analysis recognised (a Ring) is roughed and finished from the
// bar on its own diameter and length (turned-diameters.ts), and the line's time is their sum. Every expected time below is worked out by
// hand from the stored Rough Turning and Finish Turning calculators' formulas, which time a cut as the Machining calculator workbook's
// Turning sheet does (spindle speed from the diameter the cut starts at, the length of cut plus 10 mm, passes = stock / depth of cut):
//
//   Finish Start Ø = min(Ring Ø + 2 * Finish Depth of Cut, Bar Ø)                              what roughing leaves for the finish cut
//   Rough Passes   = (Bar Ø - Finish Start Ø) / (2 * Rough Depth of Cut)                       not rounded
//   Rough          = Rough Passes * (Ring length + 10) / (Rough Speed * 1000 / (pi * Bar Ø) * Rough Feed) * 60               [s]
//   Finish         = (Ring length + 10) / (Finish Speed * 1000 / (pi * Finish Start Ø) * Finish Feed) * 60, one pass          [s]
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

  it('rough turns every diameter from the bar: the Ø12 steps nearly a pass each, the Ø14 the 0.2 mm above its finish cut', () => {
    // Every rough cut starts at the bar: spindle 250.4 * 1000 / (pi * 16) = 4981.55 rpm; feed 4981.55 * 0.3625 = 1805.81 mm/min.
    // Ø14: finish start 14 + 1.6 = 15.6; passes (16 - 15.6) / 2.6 = 0.1538; (8 + 10) / 1805.81 * 60 = 0.5981 s a pass -> 0.0920 s.
    // Ø12: finish start 12 + 1.6 = 13.6; passes (16 - 13.6) / 2.6 = 0.9231.
    //      18 mm: (18 + 10) / 1805.81 * 60 = 0.9303 s a pass -> 0.8588 s;  5 mm: (5 + 10) / 1805.81 * 60 = 0.4984 s a pass -> 0.4601 s.
    // Line: 0.0920 + 0.8588 + 0.4601 = 1.4108 s (summed before rounding).
    expect(sec(rough)).toBeCloseTo(1.4108, 2);
    expect(rough.featureBreakdown).toEqual([
      { name: 'Rough Turning // Ring Ø14 x 8 mm', timeSec: expect.closeTo(0.0920, 4), featureType: 'Ring', count: 1, faceIds: [9] },
      { name: 'Rough Turning // Ring Ø12 x 18 mm', timeSec: expect.closeTo(0.8588, 4), featureType: 'Ring', count: 1, faceIds: [17] },
      { name: 'Rough Turning // Ring Ø12 x 5 mm', timeSec: expect.closeTo(0.4601, 4), featureType: 'Ring', count: 1, faceIds: [24] },
    ]);
    // 1.4108 s at 900 per hour = 0.35, with the lathe's setup: 4.85.
    expect(rough.runCost).toBe(0.35);
    expect(rough.totalCost).toBe(4.85);
  });

  it('finish turns all three, one pass each', () => {
    // Each finish cut starts at the diameter roughing left: the Ring's own plus 0.8 mm a side.
    // Ø14 x 8:  start 15.6; spindle 333.1 * 1000 / (pi * 15.6) = 6796.73 rpm; feed 6796.73 * 0.29 = 1971.05 mm/min; (8 + 10) / 1971.05 * 60 = 0.5479 s.
    // Ø12:      start 13.6; spindle 333.1 * 1000 / (pi * 13.6) = 7796.25 rpm; feed 7796.25 * 0.29 = 2260.91 mm/min.
    //           (18 + 10) / 2260.91 * 60 = 0.7431 s;  (5 + 10) / 2260.91 * 60 = 0.3981 s.
    // Line: 0.5479 + 0.7431 + 0.3981 = 1.6891 s.
    expect(sec(finish)).toBeCloseTo(1.6891, 2);
    expect(finish.featureBreakdown).toEqual([
      { name: 'Finish Turning // Ring Ø14 x 8 mm', timeSec: expect.closeTo(0.5479, 4), featureType: 'Ring', count: 1, faceIds: [9] },
      { name: 'Finish Turning // Ring Ø12 x 18 mm', timeSec: expect.closeTo(0.7431, 4), featureType: 'Ring', count: 1, faceIds: [17] },
      { name: 'Finish Turning // Ring Ø12 x 5 mm', timeSec: expect.closeTo(0.3981, 4), featureType: 'Ring', count: 1, faceIds: [24] },
    ]);
    // 1.6891 s at 900 per hour = 0.42.
    expect(finish.totalCost).toBe(0.42);
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
    expect([...new Set(trace.map((s) => s.group).filter(Boolean))]).toEqual(['Ring Ø14 x 8 mm', 'Ring Ø12 x 18 mm', 'Ring Ø12 x 5 mm']);
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Rough Passes')).toMatchObject({ value: 0.9231 });
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Spindle Speed')).toMatchObject({ value: 4981.55, unit: 'rpm' });
    // The workbook's 10 mm approach is an input of each run: the calculator's own stored value, stated as the allowance it is.
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Approach Length')).toMatchObject({
      kind: 'input', value: 10, unit: 'mm', source: expect.stringMatching(/^Assumption: .*Turning sheet: length of cut \+ 10 mm/),
    });
    expect(rough.confidence).toBe('derived');
    expect(trace.find((s) => s.fieldName === 'Rough Turning cycle time')).toMatchObject({ kind: 'calculated', value: 1.4108, unit: 's' });
    // The setup is still the last thing in the line's calculation.
    expect(trace.find((s) => s.fieldName === 'Setup time')).toMatchObject({ value: 30 });
    // Reopened, the calculator fills from the first Ring, whose inputs open that Ring's faces on the model.
    const first = calculatorInputSteps(trace);
    expect(first.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 14, ref: { kind: 'faces', label: 'Ring Ø14 x 8 mm', faceIds: [9] } });
    expect(first.find((s) => s.fieldName === 'Turned Length')).toMatchObject({ value: 8 });
    expect(first.find((s) => s.fieldName === 'Bar Diameter')).toMatchObject({ value: 16 });
  });

  it('the summary\'s turning minutes are the two lines\'', () => {
    expect(result.cycleTimes.laserMin).toBe(Math.round(((1.4108 + 1.6891) / 60) * 100) / 100);
  });
});

describe('the bar at the largest diameter: that diameter is left as supplied, the steps are still turned', () => {
  it('Ø14 bar, Ø12 steps: the 0.2 mm above the finish cut is roughed, then one finish pass', () => {
    // Ø14: radial 0 -> as supplied, on neither line.
    // Ø12: finish start 13.6; passes (14 - 13.6) / 2.6 = 0.1538; spindle 250.4 * 1000 / (pi * 14) = 5693.20 rpm; feed 2063.78 mm/min.
    //      rough  (18 + 10) / 2063.78 * 60 = 0.8140 s a pass -> 0.1252 s;  (5 + 10) / 2063.78 * 60 = 0.4361 s a pass -> 0.0671 s: 0.1923 s.
    //      finish (18 + 10) / 2260.91 * 60 = 0.7431 s and (5 + 10) / 2260.91 * 60 = 0.3981 s: 1.1412 s.
    const { processLines } = cost(shaft({ blankResult: bar(14) }));
    expect(sec(lineOf(processLines, 'Rough Turning'))).toBeCloseTo(0.1923, 2);
    expect(sec(lineOf(processLines, 'Finish Turning'))).toBeCloseTo(1.1412, 2);
    expect(lineOf(processLines, 'Rough Turning')!.featureBreakdown!.map((f) => f.name)).toEqual(['Rough Turning // Ring Ø12 x 18 mm', 'Rough Turning // Ring Ø12 x 5 mm']);
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
  });

  it('Ø14 bar, Ø12.4 steps: stock no deeper than the finish cut is one finish pass and no rough pass; the setup is on Finish Turning', () => {
    // Ø12.4: radial (14 - 12.4) / 2 = 0.8, the finish depth of cut: finish start min(12.4 + 1.6, 14) = 14, so (14 - 14) / 2.6 = 0 rough passes
    //        -> no Rough Turning line at all.
    //        finish starts at the bar: spindle 333.1 * 1000 / (pi * 14) = 7573.50 rpm; feed 2196.32 mm/min;
    //        (18 + 10) / 2196.32 * 60 = 0.7649 s and (5 + 10) / 2196.32 * 60 = 0.4098 s: 1.1747 s.
    const rings: TurnedRing[] = [RINGS[0]!, { ...RINGS[1]!, diameterMm: 12.4 }, { ...RINGS[2]!, diameterMm: 12.4 }];
    const { processLines, warnings } = cost(shaft({ blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings } }));
    expect(lineOf(processLines, 'Rough Turning')).toBeUndefined();
    const finish = lineOf(processLines, 'Finish Turning')!;
    expect(sec(finish)).toBeCloseTo(1.1747, 2);
    expect(finish.featureBreakdown!.map((f) => f.name)).toEqual(['Finish Turning // Ring Ø12.4 x 18 mm', 'Finish Turning // Ring Ø12.4 x 5 mm']);
    expect(setupCarriers(processLines)).toEqual(['Finish Turning']);
    expect(finish).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(finish.calculationTrace!.find((s) => s.fieldName === 'Setup time')).toMatchObject({ value: 30 });
    expect(lineDataGap(finish)).toBeNull();
    expect(warnings.some((w) => w.includes('Turning not priced') || w.includes('setup not charged'))).toBe(false);
  });

  it('Ø14 bar, a Ø10 step: 2 mm of radial stock is roughed, and the setup is back on Rough Turning', () => {
    // Ø10 x 20: finish start 11.6; passes (14 - 11.6) / 2.6 = 0.9231.
    //   rough  spindle 250.4 * 1000 / (pi * 14) = 5693.20 rpm; feed 2063.78 mm/min; (20 + 10) / 2063.78 * 60 = 0.8722 s a pass -> 0.8051 s.
    //   finish spindle 333.1 * 1000 / (pi * 11.6) = 9140.43 rpm; feed 2650.73 mm/min; (20 + 10) / 2650.73 * 60 = 0.6791 s.
    const rings: TurnedRing[] = [{ id: 'od_0', diameterMm: 14, lengthMm: 12, faceIds: [1] }, { id: 'od_1', diameterMm: 10, lengthMm: 20, faceIds: [2] }];
    const { processLines } = cost(shaft({ blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings } }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    const finish = lineOf(processLines, 'Finish Turning')!;
    expect(sec(rough)).toBeCloseTo(0.8051, 2);
    expect(sec(finish)).toBeCloseTo(0.6791, 2);
    expect(rough.featureBreakdown).toEqual([{ name: 'Rough Turning // Ring Ø10 x 20 mm', timeSec: expect.closeTo(0.8051, 4), featureType: 'Ring', count: 1, faceIds: [2] }]);
    // One Ring turned: its run is the line's calculation as it is, under the calculator's own field names.
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 10, source: 'CAD: turned outer diameter (Ring feature)' });
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
  });
});

describe('a part analysed without Ring features: one run on its fallback cylinder, as before', () => {
  // Ø20 x 100 from a Ø30 bar: finish start 21.6; passes (30 - 21.6) / 2.6 = 3.2308.
  //   rough  spindle 250.4 * 1000 / (pi * 30) = 2656.83 rpm; feed 963.10 mm/min; (100 + 10) / 963.10 * 60 = 6.8529 s a pass; x 3.2308 = 22.1401 s.
  //   finish spindle 333.1 * 1000 / (pi * 21.6) = 4908.75 rpm; feed 1423.54 mm/min; (100 + 10) / 1423.54 * 60 = 4.6363 s.
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
    expect(sec(rough)).toBeCloseTo(22.1401, 1);
    expect(sec(finish)).toBeCloseTo(4.6363, 1);
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
    expect(rough.physicsGap).toMatchObject({ gapType: 'unsupported_operation', reason: expect.stringContaining('bar stock for this part (the stock chosen is 16 x 16 x 34 billet, which a lathe does not turn from)') });
    expect(rough.confidence).toBe('unsupported');
    expect(rough.featureBreakdown).toBeUndefined();
    expect(lineDataGap(rough)?.reason).toContain('bar stock for this part');
    expect(lineOf(processLines, 'Finish Turning')).toBeUndefined();
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
    expect(warnings.some((w) => w.includes('Turning not priced') && w.includes('bar stock for this part'))).toBe(true);
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
    expect(sec(lineOf(processLines, 'Finish Turning'))).toBeCloseTo(1.6891, 2);
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
    // 1.4108 s over 2 stations = 0.7054 s.
    expect(sec(rough)).toBeCloseTo(0.7054, 2);
    expect(rough.featureBreakdown!.reduce((s, f) => s + f.timeSec, 0)).toBeCloseTo(0.7054, 3);
  });
});
