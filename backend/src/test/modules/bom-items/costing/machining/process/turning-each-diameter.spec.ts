// A turned part is turned one diameter at a time: each turned diameter the analysis recognised (a Ring) is roughed and finished from the
// bar on its own diameter and length (turned-diameters.ts), and the line's time is their sum. Every expected time below is worked out by
// hand from the Machining calculator workbook's Turning sheet, as the stored Rough Turning and Finish Turning calculators (migration 1138)
// time a cut:
//
//   Finish Start Ø = min(Ring Ø + 2 * Finish Depth of Cut, Bar Ø)                       what roughing leaves for the finish cut
//   Rough Passes   = ceil((Bar Ø - Finish Start Ø) / (2 * Rough Depth of Cut))           whole passes
//   n              = min(machine's spindle limit, v * 1000 / (pi * the Ø the cut starts at))
//   time           = ceil((Ring length + 10) / (feed * n) * passes * 60)                  whole seconds per cut
//
// The fixture is aluminium on carbide, read from the workbook's Turning cutting conditions at the calculators' Range Position 0.3 of
// each range (migration 1158):
//   rough, depth of cut 2 (band 0.5-2):     90-450 m/min -> 198, 0.2-0.3 mm/rev -> 0.23
//   finish, depth of cut 0.5 (band 0.1-0.5): 150-600 m/min -> 285, 0.05-0.2 mm/rev -> 0.095
// and the lathe (a 2 axis bar feed lathe with sub spindle, the Haas DS-30) turns at most 4000 rpm. Every finish cut on these small
// diameters reaches it (finish feed 0.095 * 4000 = 380 mm/min); a rough cut from a Ø16 bar turns at 198 000 / (pi * 16) = 3939.08 rpm
// (feed 0.23 * 3939.08 = 905.99 mm/min), from a Ø14 bar at the limit (0.23 * 4000 = 920 mm/min).
import {
  computeTurningCostSummary,
  type MachiningCostInput,
  type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { calculatorInputSteps } from '../../../../../../modules/bom-items/costing/machining/process/machining-trace';
import { lineDataGap } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { realPartoffTable } from '../real-reference-tables';
import { TEST_INR_PER_USD, workbookFixture } from '../workbook-fixture';

import type { TurnedRing } from '../../../../../../modules/bom-items/costing/machining/process/turned-diameters';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { ProcessLineCost } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';

const CALCS = specAsCalculators();
const LATHE = '2_axis_bar_feed_lathe_with_sub_spindle';
const mc = (s: string) => s as MachineClassId;
const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);
/** The lathe: the Haas DS-30's 4000 rpm spindle (memory/machining/machine/machiningusa.csv, migration 1136). */
const latheRate = (extra: Partial<MHRRateInput> = {}) => rate(900, { machineClass: LATHE, setupTimeHr: 0.5, maxSpindleRpm: 4000, ...extra });

// The stepped shaft: Ø14 in the middle, a Ø12 step at each end, 32 mm long.
const RINGS: TurnedRing[] = [
  { id: 'od_0', diameterMm: 14, lengthMm: 8, faceIds: [9] },
  { id: 'od_1', diameterMm: 12, lengthMm: 18, faceIds: [17] },
  { id: 'od_2', diameterMm: 12, lengthMm: 5, faceIds: [24] },
];
// The piece cut for one part, with the 0.5 mm the stock model left on each end for the facing.
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
    mhrRate: latheRate(),
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
/** The lathe's own lines that charge a setup. */
const setupCarriers = (lines: ProcessLineCost[]) => lines.filter((l) => l.machineClass === LATHE && l.setupCost > 0).map((l) => l.process);

describe('a stepped shaft from a Ø16 bar: each diameter is turned on its own radial stock', () => {
  const result = cost(shaft());
  const facing = lineOf(result.processLines, 'End Machining')!;
  const rough = lineOf(result.processLines, 'Rough Turning')!;
  const finish = lineOf(result.processLines, 'Finish Turning')!;

  it('faces both ends first: across the bar radius, one pass over the 0.5 mm end allowance, whole seconds a face, with the tool', () => {
    // (8 + 10) / 380 = 0.0474 min = 2.84 s -> 3 s a face; both ends: 6 s.
    expect(sec(facing)).toBeCloseTo(6, 2);
    // Tool wear: the workbook's turning insert holder, Rs 732.40 over 1000 parts = Rs 0.7324 a part.
    expect(facing.otherCostPerPart).toBeCloseTo(0.7324 / TEST_INR_PER_USD, 8);
    expect(facing.otherCostDetail).toBe('tool wear Rs 0.73 per part');
    expect(facing.totalCost).toBeCloseTo(SETUP_COST + (6 * 900) / 3600 + 0.7324 / TEST_INR_PER_USD, 6);
  });

  it('rough turns every diameter from the bar, each a whole pass and whole seconds', () => {
    // Ø14 x 8:  finish start 15, ceil((16 - 15) / 4) = 1 pass; (8 + 10) / 905.99 = 1.19 s -> 2 s.
    // Ø12 x 18: finish start 13, ceil((16 - 13) / 4) = 1 pass; (18 + 10) / 905.99 = 1.85 s -> 2 s.
    // Ø12 x 5:  1 pass; (5 + 10) / 905.99 = 0.99 s -> 1 s.  Line: 5 s.
    expect(sec(rough)).toBeCloseTo(5, 2);
    expect(rough.featureBreakdown).toEqual([
      { name: 'Rough Turning // Ring Ø14 x 8 mm', timeSec: expect.closeTo(2, 2), featureType: 'Ring', count: 1, faceIds: [9] },
      { name: 'Rough Turning // Ring Ø12 x 18 mm', timeSec: expect.closeTo(2, 2), featureType: 'Ring', count: 1, faceIds: [17] },
      { name: 'Rough Turning // Ring Ø12 x 5 mm', timeSec: expect.closeTo(1, 2), featureType: 'Ring', count: 1, faceIds: [24] },
    ]);
    // 5 s at 900 per hour; the setup went with the facing.
    expect(rough.totalCost).toBeCloseTo((5 * 900) / 3600, 6);
  });

  it('finish turns all three, one pass each', () => {
    // Ø14 x 8: (8 + 10) / 380 = 2.84 s -> 3 s.  Ø12 x 18: (18 + 10) / 380 = 4.42 s -> 5 s.  Ø12 x 5: (5 + 10) / 380 = 2.37 s -> 3 s.
    expect(sec(finish)).toBeCloseTo(11, 2);
    expect(finish.featureBreakdown).toEqual([
      { name: 'Finish Turning // Ring Ø14 x 8 mm', timeSec: expect.closeTo(3, 2), featureType: 'Ring', count: 1, faceIds: [9] },
      { name: 'Finish Turning // Ring Ø12 x 18 mm', timeSec: expect.closeTo(5, 2), featureType: 'Ring', count: 1, faceIds: [17] },
      { name: 'Finish Turning // Ring Ø12 x 5 mm', timeSec: expect.closeTo(3, 2), featureType: 'Ring', count: 1, faceIds: [24] },
    ]);
    expect(finish.totalCost).toBeCloseTo((11 * 900) / 3600, 6);
  });

  it('the setup is on the facing, the lathe\'s first cut, once', () => {
    expect(setupCarriers(result.processLines)).toEqual(['End Machining']);
    expect(facing).toMatchObject({ setupCost: SETUP_COST, setupTimeMin: 30, setupTimeSource: 'machine' });
    expect(rough).toMatchObject({ setupCost: 0, setupTimeMin: 0, setupTimeSource: 'none' });
    expect(finish).toMatchObject({ setupCost: 0, setupTimeMin: 0, setupTimeSource: 'none' });
  });

  it('no lathe line is a data gap: the route is fully costed', () => {
    for (const l of [facing, rough, finish]) {
      expect(lineDataGap(l)).toBeNull();
      expect(l.physicsGap).toBeUndefined();
    }
    expect(result.warnings.some((w) => /^(Turning|End facing|Parting) not priced/.test(w))).toBe(false);
  });

  it('each line keeps one calculator and every Ring\'s run under the Ring\'s name, then their sum', () => {
    expect(rough.calculatorId).toBe('Machining - Rough Turning');
    expect(finish.calculatorId).toBe('Machining - Finish Turning');
    expect(facing.calculatorId).toBe('Machining - End Facing');
    const trace = rough.calculationTrace!;
    expect([...new Set(trace.map((s) => s.group).filter(Boolean))]).toEqual(['Ring Ø14 x 8 mm', 'Ring Ø12 x 18 mm', 'Ring Ø12 x 5 mm']);
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Rough Passes')).toMatchObject({ value: 1 });
    // The speed and feed are the workbook's ranges, picked at the Range Position; the spindle is capped at the machine's limit.
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Rough Speed Min')).toMatchObject({ value: 90, source: expect.stringContaining('tblTurningConditions: Aluminium alloys') });
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Rough Speed Max')).toMatchObject({ value: 450 });
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Rough Cutting Speed')).toMatchObject({ value: 198 });
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Max Spindle Speed')).toMatchObject({ value: 4000, source: expect.stringContaining('spindle_speed_rpm') });
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Spindle Speed')).toMatchObject({ value: 3939.08, unit: 'rpm' });
    // The workbook's 10 mm approach is an input of each run, stated as the allowance it is.
    expect(trace.find((s) => s.fieldName === 'Ring Ø12 x 18 mm · Approach Length')).toMatchObject({
      kind: 'input', value: 10, unit: 'mm', source: expect.stringMatching(/Turning sheet: the length of cut plus 10 mm/), ref: { kind: 'calculatorField', calculator: 'Machining - Rough Turning', field: 'Approach Length' },
    });
    expect(trace.find((s) => s.fieldName === 'Rough Turning cycle time')).toMatchObject({ kind: 'calculated', value: 5, unit: 's' });
    // Reopened, the calculator fills from the first Ring, whose inputs open that Ring's faces on the model.
    const first = calculatorInputSteps(trace);
    expect(first.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 14, ref: { kind: 'faces', label: 'Ring Ø14 x 8 mm', faceIds: [9] } });
    expect(first.find((s) => s.fieldName === 'Turned Length')).toMatchObject({ value: 8 });
    expect(first.find((s) => s.fieldName === 'Bar Diameter')).toMatchObject({ value: 16 });
  });
});

describe('the bar at the largest diameter: that diameter is left as supplied, the steps are still turned', () => {
  it('Ø14 bar, Ø12 steps: one rough pass, then one finish pass', () => {
    // Ø14: radial 0 -> as supplied, on neither line.
    // Ø12 x 18: rough (18 + 10) / 920 = 1.83 s -> 2 s, finish 5 s;  Ø12 x 5: rough 0.98 s -> 1 s, finish 3 s.
    const { processLines } = cost(shaft({ blankResult: bar(14) }));
    expect(sec(lineOf(processLines, 'Rough Turning'))).toBeCloseTo(3, 2);
    expect(sec(lineOf(processLines, 'Finish Turning'))).toBeCloseTo(8, 2);
    expect(lineOf(processLines, 'Rough Turning')!.featureBreakdown!.map((f) => f.name)).toEqual(['Rough Turning // Ring Ø12 x 18 mm', 'Rough Turning // Ring Ø12 x 5 mm']);
  });

  it('Ø14 bar, Ø13 steps: stock no deeper than the finish cut is one finish pass and no rough pass', () => {
    // Ø13: radial (14 - 13) / 2 = 0.5, the finish depth of cut: finish start min(13 + 1, 14) = 14, ceil(0 / 4) = 0 rough passes
    //      -> no Rough Turning line at all; finish 5 s + 3 s.
    const rings: TurnedRing[] = [RINGS[0]!, { ...RINGS[1]!, diameterMm: 13 }, { ...RINGS[2]!, diameterMm: 13 }];
    const { processLines, warnings } = cost(shaft({ blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings } }));
    expect(lineOf(processLines, 'Rough Turning')).toBeUndefined();
    const finish = lineOf(processLines, 'Finish Turning')!;
    expect(sec(finish)).toBeCloseTo(8, 2);
    expect(finish.featureBreakdown!.map((f) => f.name)).toEqual(['Finish Turning // Ring Ø13 x 18 mm', 'Finish Turning // Ring Ø13 x 5 mm']);
    expect(lineDataGap(finish)).toBeNull();
    expect(warnings.some((w) => w.includes('Turning not priced'))).toBe(false);
  });

  it('Ø14 bar, a Ø10 step: 2 mm of radial stock is one rough pass', () => {
    // Ø10 x 20: finish start 11, ceil((14 - 11) / 4) = 1 pass; rough (20 + 10) / 920 = 1.96 s -> 2 s; finish (20 + 10) / 380 = 4.74 s -> 5 s.
    const rings: TurnedRing[] = [{ id: 'od_0', diameterMm: 14, lengthMm: 12, faceIds: [1] }, { id: 'od_1', diameterMm: 10, lengthMm: 20, faceIds: [2] }];
    const { processLines } = cost(shaft({ blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings } }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    expect(sec(rough)).toBeCloseTo(2, 2);
    expect(sec(lineOf(processLines, 'Finish Turning'))).toBeCloseTo(5, 2);
    expect(rough.featureBreakdown).toEqual([{ name: 'Rough Turning // Ring Ø10 x 20 mm', timeSec: expect.closeTo(2, 2), featureType: 'Ring', count: 1, faceIds: [2] }]);
    // One Ring turned: its run is the line's calculation as it is, under the calculator's own field names.
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 10, source: 'CAD: turned outer diameter (Ring feature)' });
  });
});

describe('a part analysed without Ring features: one run on its fallback cylinder, as before', () => {
  // Ø20 x 100 from a Ø30 bar: finish start 21, ceil((30 - 21) / 4) = 3 passes.
  //   rough  n = 198 * 1000 / (pi * 30) = 2100.85 rpm (under the limit); feed 0.23 * 2100.85 = 483.19 mm/min;
  //          (100 + 10) / 483.19 * 3 = 0.6830 min = 40.98 s -> 41 s.
  //   finish n = min(4000, 285 * 1000 / (pi * 21)) = 4000; (100 + 10) / 380 = 17.37 s -> 18 s.
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
    expect(sec(rough)).toBeCloseTo(41, 2);
    expect(sec(finish)).toBeCloseTo(18, 2);
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Spindle Speed')).toMatchObject({ value: 2100.85 });
    expect(rough.featureBreakdown).toBeUndefined();
    expect(finish.featureBreakdown).toBeUndefined();
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Turned Diameter')).toMatchObject({ value: 20, source: fallback.diameterSource });
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Turned Length')).toMatchObject({ value: 100, source: fallback.lengthSource });
    expect(rough.calculationTrace!.some((s) => s.group)).toBe(false);
  });

  it('an empty Ring list is the same part', () => {
    expect(cost(input([])).processLines).toEqual(cost(input()).processLines);
  });
});

describe('the lathe\'s setup when nothing is turned (the bar is the part\'s only diameter)', () => {
  const plain = (overrides: Partial<MachiningCostInput> = {}) => shaft({
    blankResult: bar(14), turnedGeometry: { ...shaft().turnedGeometry!, rings: [{ id: 'od_0', diameterMm: 14, lengthMm: 32, faceIds: [9] }] }, ...overrides,
  });

  it('the ends are still faced: the setup is on End Machining, then the drilling and the part-off', () => {
    const { processLines, warnings } = cost(plain({ holeCount: 1, holeGroups: [{ diameter_mm: 4, count: 1, depth_mm: 10 }] }));
    expect(lineOf(processLines, 'Rough Turning')).toBeUndefined();
    expect(lineOf(processLines, 'Finish Turning')).toBeUndefined();
    expect(lineOf(processLines, 'Drilling')!.cycleTimeMin).toBeGreaterThan(0);
    expect(setupCarriers(processLines)).toEqual(['End Machining']);
    expect(lineOf(processLines, 'Parting')).toMatchObject({ setupCost: 0, setupTimeSource: 'none' });
    expect(warnings.some((w) => /^(Turning|End facing|Parting) not priced/.test(w))).toBe(false);
  });

  it('no holes: the lathe faces and parts off', () => {
    const { processLines } = cost(plain());
    expect(processLines.filter((l) => l.machineClass === LATHE).map((l) => l.process)).toEqual(['End Machining', 'Parting']);
    expect(setupCarriers(processLines)).toEqual(['End Machining']);
    expect(lineDataGap(lineOf(processLines, 'Parting')!)).toBeNull();
  });

  it('cut off by a saw: the piece is still faced on the lathe, which carries the setup', () => {
    const { processLines, totalProcessCost } = cost(plain({ stockCutOff: 'saw' }));
    expect(processLines.filter((l) => l.machineClass === LATHE).map((l) => l.process)).toEqual(['End Machining']);
    expect(setupCarriers(processLines)).toEqual(['End Machining']);
    expect(totalProcessCost).toBeCloseTo(processLines.reduce((s, l) => s + l.totalCost, 0), 8);
  });
});

describe('turning that cannot be priced is still a gap line, with its reason and the setup', () => {
  it('no round bar to turn from: no facing either, and the turning gap carries the setup', () => {
    const { processLines, warnings } = cost(shaft({ blankResult: { form: 'billet', sizeLabel: '16 x 16 x 34 billet', billetVolMm3: 16 * 16 * 34, utilizationPct: 40 } }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    expect(rough.cycleTimeMin).toBe(0);
    expect(rough.physicsGap).toMatchObject({ gapType: 'unsupported_operation', reason: expect.stringContaining('bar stock for this part (the stock chosen is 16 x 16 x 34 billet, which a lathe does not turn from)') });
    expect(rough.confidence).toBe('unsupported');
    expect(lineOf(processLines, 'End Machining')).toBeUndefined();
    expect(lineOf(processLines, 'Finish Turning')).toBeUndefined();
    expect(setupCarriers(processLines)).toEqual(['Rough Turning']);
    expect(warnings.some((w) => w.includes('Turning not priced') && w.includes('bar stock for this part'))).toBe(true);
  });

  it('the workbook\'s tables not read: each workbook-form line names the table it could not read', () => {
    const { processLines } = cost(shaft({ workbook: null }));
    for (const process of ['End Machining', 'Rough Turning', 'Finish Turning']) {
      const line = lineOf(processLines, process)!;
      expect(line.cycleTimeMin).toBe(0);
      expect(lineDataGap(line)?.reason).toContain('tblTurningConditions (machining_reference_data) could not be read');
    }
  });

  it('a material the workbook has no turning row for (plastic): the line names it', () => {
    const { processLines } = cost(shaft({ materialGrade: 'Delrin (POM)' }));
    expect(lineDataGap(lineOf(processLines, 'Rough Turning')!)?.reason).toContain("the machining workbook's tblTurningConditions has no row for plastic");
  });

  it('a lathe with no spindle limit on file: the line names the machine input it lacks, it never assumes one', () => {
    const { processLines } = cost(shaft({ mhrRate: latheRate({ maxSpindleRpm: null }) }));
    expect(lineDataGap(lineOf(processLines, 'Rough Turning')!)?.reason).toContain('Max Spindle Speed');
  });

  it('no calculator mapped for the operation', () => {
    const { ['Rough Turning']: _rough, ...withoutRough } = CALCS;
    const { processLines } = cost(shaft({ machiningCalculators: withoutRough }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    expect(rough.cycleTimeMin).toBe(0);
    expect(rough.physicsGap).toMatchObject({ reason: expect.stringContaining('a calculator for "Rough Turning"') });
    expect(sec(lineOf(processLines, 'Finish Turning'))).toBeCloseTo(11, 2);
  });

  it('nothing to turn needs no cutting data: no turning gap', () => {
    const { processLines, warnings } = cost(shaft({ blankResult: bar(12), turnedGeometry: { ...shaft().turnedGeometry!, diameterMm: 12, rings: [RINGS[1]!] } }));
    expect(lineOf(processLines, 'Rough Turning')).toBeUndefined();
    expect(warnings.some((w) => w.includes('Turning not priced'))).toBe(false);
  });
});

describe('a multi-spindle sharing the rough turning over its stations', () => {
  it('each Ring\'s row is its share, so the rows still add up to the line', () => {
    const { processLines } = cost(shaft({
      mhrRate: latheRate({ numberSpindles: 6 }),
      roughTurningOpSplit: { shouldSplit: true, numberOfOperations: 2, thresholdRatio: 0.22, dataFound: true },
    }));
    const rough = lineOf(processLines, 'Rough Turning')!;
    // 5 s over 2 stations = 2.5 s.
    expect(sec(rough)).toBeCloseTo(2.5, 2);
    expect(rough.featureBreakdown!.reduce((s, f) => s + f.timeSec, 0)).toBeCloseTo(2.5, 2);
  });
});
