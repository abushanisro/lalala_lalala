// A turned part's external threads are single-point turned on their turned diameters and its knurls rolled on theirs (user decisions
// 2026-11-25), each timed by its workbook calculator (migration 1138): before, a drawn external thread was a Tapping line at the tapping
// calculator's thread-engagement depth. Every expected time below is worked out by hand from the Machining calculator workbook:
//
//   Threading sheet: n = min(machine's limit, 5 m/min x 1000 / (pi D)); time = ceil((L + 4) / (pitch x n) x 4 passes x 60) s per thread
//   Knurling sheet:  n = min(machine's limit, 6 m/min x 1000 / (pi D)); time = ceil((L + 4) / (feed x n) x 4 passes x 60) s,
//                    the feed the Turning cutting conditions' Carbide finishing band (aluminium: 0.05-0.2 mm/rev -> 0.125)
//
// The part: the stepped shaft of turning-each-diameter.spec.ts, aluminium on the Haas DS-30 (4000 rpm), from a Ø16 bar: a Ø14 x 8.145
// collar and an M12 x 1.75 journal turned to Ø12 x 18.329.
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  computeTurningCostSummary, type MachiningCostInput, type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { knurlsOnRings, splitExternalThreads } from '../../../../../../modules/bom-items/costing/machining/external-threads';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { calculatorInputSteps } from '../../../../../../modules/bom-items/costing/machining/process/machining-trace';
import { multiSpindleWork } from '../../../../../../modules/bom-items/costing/multi-spindle/multi-spindle-work';
import { lineDataGap } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { realPartoffTable } from '../real-reference-tables';
import { TEST_INR_PER_USD, workbookFixture } from '../workbook-fixture';

import type { TurnedRing } from '../../../../../../modules/bom-items/costing/machining/process/turned-diameters';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { ProcessLineCost } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';

const LATHE = '2_axis_bar_feed_lathe_with_sub_spindle';
const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);

const COLLAR: TurnedRing = { id: 'od_0', diameterMm: 14, lengthMm: 8.145, faceIds: [9] };
const JOURNAL: TurnedRing = { id: 'od_1', diameterMm: 12, lengthMm: 18.329, faceIds: [17] };
const RINGS = [COLLAR, JOURNAL];

function shaft(overrides: Partial<MachiningCostInput> = {}): MachiningCostInput {
  return {
    volume: 4000, surfaceArea: 1500, maxLength: 27, maxWidth: 14, maxHeight: 14,
    holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 100, family: 'turned', finishedWeightKg: 0.011,
    mhrRate: rate(900, { machineClass: LATHE, setupTimeHr: 0.5, maxSpindleRpm: 4000 }),
    tappingRate: rate(900, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null,
    machiningCalculators: specAsCalculators(),
    turnedGeometry: {
      diameterMm: 14, lengthMm: 27,
      diameterSource: 'CAD: largest turned outer diameter (Ring feature)', lengthSource: 'CAD: bounding-box extent along the turning axis',
      rings: RINGS,
    },
    blankResult: { form: 'round_bar', sizeLabel: 'Ø16 round bar', billetVolMm3: Math.PI * 64 * 28, utilizationPct: 60, barDiameterMm: 16, endAllowanceMm: 0.5 },
    workbook: workbookFixture(),
    partoffTable: realPartoffTable(),
    ...overrides,
  };
}

const cost = (input: MachiningCostInput) => computeTurningCostSummary(input, LATHE as MachineClassId);
const lineOf = (lines: ProcessLineCost[], process: string) => lines.find((l) => l.process === process);
const sec = (l: ProcessLineCost | undefined) => (l ? l.cycleTimeMin * 60 : null);
// Rs 100 a thread turning tool or a knurling tool, over 300 parts (the workbook's tool cost table).
const TOOL_USD = 100 / 300 / TEST_INR_PER_USD;

// The drawing calls "M12x1.75" (a drawing analysed before the class was read: no class), the CAD taps no M12 hole.
const DRAWN_M12 = [{ size: 'M12', count: 1, pitchMm: 1.75 }];

describe('an M12 x 1.75 external thread on the Ø12 x 18.329 journal', () => {
  const split = splitExternalThreads(DRAWN_M12, RINGS, []);
  const result = cost(shaft({ threads: split.internal, externalThreads: split.external }));
  const threading = lineOf(result.processLines, 'Thread Turning')!;

  it('is turned, not tapped: a Thread Turning line, and no Tapping line', () => {
    expect(split.internal).toEqual([]);
    expect(threading).toBeDefined();
    expect(lineOf(result.processLines, 'Tapping')).toBeUndefined();
    // Before: the same callout tapped as a hole, at the tapping calculator's engagement depth.
    expect(lineOf(cost(shaft({ threads: DRAWN_M12 })).processLines, 'Tapping')).toBeDefined();
  });

  it('timed as the Threading sheet times it, with the thread turning tool\'s wear', () => {
    // n = 5000 / (pi x 12) = 132.63 rpm; (18.329 + 4) / (1.75 x 132.63) x 4 = 0.3848 min = 23.09 s -> 24 s, one thread.
    expect(sec(threading)).toBeCloseTo(24, 4);
    expect(threading.calculatorId).toBe('Machining - Thread Turning');
    expect(threading.otherCostPerPart).toBeCloseTo(TOOL_USD, 8);
    expect(threading.totalCost).toBeCloseTo((24 * 900) / 3600 + TOOL_USD, 6);
    // The lathe's setup is on its facing.
    expect(threading.setupCost).toBe(0);
    expect(lineDataGap(threading)).toBeNull();
    expect(threading.featureBreakdown).toEqual([
      { name: 'Thread Turning // Ring Ø12 x 18.33 mm', timeSec: expect.closeTo(24, 4), featureType: 'Ring', count: 1, faceIds: [17] },
    ]);
  });

  it('every input says where it came from, and the thread\'s diameter and length open the journal\'s faces', () => {
    const steps = calculatorInputSteps(threading.calculationTrace!);
    const ref = { kind: 'faces', label: 'Ring Ø12 x 18.33 mm', faceIds: [17] };
    expect(steps.find((s) => s.fieldName === 'Thread Diameter')).toMatchObject({
      value: 12, ref, source: expect.stringMatching(/^CAD: the turned diameter the thread is cut on \(Ring feature\); the M12 callout states no class/),
    });
    expect(steps.find((s) => s.fieldName === 'Thread Length')).toMatchObject({ value: 18.329, ref, source: 'CAD: length of the turned diameter the thread is cut on (Ring feature)' });
    expect(steps.find((s) => s.fieldName === 'Pitch')).toMatchObject({ value: 1.75, source: 'Drawing: pitch of the M12 x 1.75 callout' });
    expect(steps.find((s) => s.fieldName === 'Threads')).toMatchObject({ value: 1, source: 'Drawing: one M12 thread on this turned diameter' });
    expect(steps.find((s) => s.fieldName === 'Max Spindle Speed')).toMatchObject({ value: 4000 });
    expect(steps.find((s) => s.fieldName === 'Approach Length')).toMatchObject({ value: 4, source: expect.stringMatching(/^Assumption: /) });
  });

  it('an external thread by its class with no Ring: 1.5 x its nominal diameter long, stated as the assumption it is', () => {
    const [m20] = splitExternalThreads([{ size: 'M20', count: 1, pitchMm: 2.5, pitchStated: true, threadKind: 'external', toleranceClass: '6g' }], RINGS, []).external;
    const line = lineOf(cost(shaft({ externalThreads: [m20!] })).processLines, 'Thread Turning')!;
    // n = 5000 / (pi x 20) = 79.58 rpm; (30 + 4) / (2.5 x 79.58) x 4 = 0.6836 min = 41.02 s -> 42 s.
    expect(sec(line)).toBeCloseTo(42, 4);
    expect(line.confidence).toBe('derived');
    expect(calculatorInputSteps(line.calculationTrace!).find((s) => s.fieldName === 'Thread Length')).toMatchObject({
      value: 30, source: expect.stringMatching(/^Assumption: 1\.5 x the 20 mm nominal diameter/),
    });
    // No Ring is cut: nothing to list or light.
    expect(line.featureBreakdown).toBeUndefined();
  });
});

describe('a knurl on the Ø14 x 8.145 collar', () => {
  const knurls = knurlsOnRings([{ pattern: 'diamond', grade: 'medium', text: 'MEDIUM DIAMOND KNURL' }], RINGS);
  const result = cost(shaft({ knurls }));
  const knurling = lineOf(result.processLines, 'Knurling')!;

  it('the note names no diameter: the largest turned diameter is knurled, stated as the assumption it is', () => {
    expect(calculatorInputSteps(knurling.calculationTrace!).find((s) => s.fieldName === 'Knurl Diameter')).toMatchObject({
      value: 14, ref: { kind: 'faces', label: 'Ring Ø14 x 8.15 mm', faceIds: [9] },
      source: expect.stringMatching(/^Assumption: the largest turned diameter; the knurl note names none/),
    });
    expect(knurling.confidence).toBe('derived');
  });

  it('timed as the Knurling sheet times it, on the finishing feed, with the knurling tool\'s wear', () => {
    // n = 6000 / (pi x 14) = 136.42 rpm; feed 0.125; (8.145 + 4) / (0.125 x 136.42) x 4 = 2.8488 min = 170.93 s -> 171 s.
    expect(sec(knurling)).toBeCloseTo(171, 4);
    expect(knurling.calculatorId).toBe('Machining - Knurling');
    expect(knurling.otherCostPerPart).toBeCloseTo(TOOL_USD, 8);
    expect(knurling.featureBreakdown).toEqual([
      { name: 'Knurling // Ring Ø14 x 8.15 mm', timeSec: expect.closeTo(171, 4), featureType: 'Ring', count: 1, faceIds: [9] },
    ]);
    expect(lineDataGap(knurling)).toBeNull();
  });

  it('a knurl with no diameter to knurl is the line\'s named gap, never a guess', () => {
    const [nowhere] = knurlsOnRings([{ text: 'DIAMOND KNURL' }], []);
    const { processLines, warnings } = cost(shaft({ knurls: [nowhere!] }));
    const line = lineOf(processLines, 'Knurling')!;
    expect(line.cycleTimeMin).toBe(0);
    expect(line.physicsGap).toMatchObject({ reason: expect.stringContaining('the diameter knurled (the knurl callout "DIAMOND KNURL" names none') });
    expect(warnings.some((w) => w.startsWith('Knurling not priced — missing real input: the diameter knurled'))).toBe(true);
  });

  it('the operation names are the catalog\'s once it has Knurling (migration 1153): no "not database-confirmed" warning', () => {
    const realOperationCategories = { [LATHE]: ['End Machining', 'Rough Turning', 'Finish Turning', 'Thread Turning', 'Knurling', 'Parting'] };
    const split = splitExternalThreads(DRAWN_M12, RINGS, []);
    const { warnings } = cost(shaft({ knurls, externalThreads: split.external, realOperationCategories }));
    expect(warnings.filter((w) => w.includes('not database-confirmed'))).toEqual([]);
  });
});

describe('with neither an external thread nor a knurl', () => {
  it('the lines are as they were', () => {
    const before = cost(shaft());
    const after = cost(shaft({ externalThreads: [], knurls: [] }));
    expect(after).toEqual(before);
    expect(before.processLines.map((l) => l.process)).not.toContain('Thread Turning');
    expect(before.processLines.map((l) => l.process)).not.toContain('Knurling');
  });

  it('with no bar the turning gap says why, and neither is priced', () => {
    const split = splitExternalThreads(DRAWN_M12, RINGS, []);
    const { processLines } = cost(shaft({ blankResult: undefined, externalThreads: split.external, knurls: knurlsOnRings([{ text: 'KNURL' }], RINGS) }));
    expect(processLines.map((l) => l.process)).not.toContain('Thread Turning');
    expect(processLines.map((l) => l.process)).not.toContain('Knurling');
  });
});

describe('on a multi-spindle', () => {
  it('the thread is chased and the knurl rolled from a cross slide, in the cycle', () => {
    const split = splitExternalThreads(DRAWN_M12, RINGS, []);
    const { processLines } = cost(shaft({ externalThreads: split.external, knurls: knurlsOnRings([{ text: 'KNURL' }], RINGS) }));
    const work = multiSpindleWork({
      lines: processLines, liveMilling: [], holes: [], threads: [], partLengthMm: 27, partVolumeMm3: 4000,
      turned: RINGS, barSectionAreaMm2: Math.PI * 64, stockLengthMm: 28,
    });
    expect(work.ops.filter((o) => o.name === 'Thread Turning' || o.name === 'Knurling').map((o) => [o.name, o.slide, Math.round(o.seconds)]))
      .toEqual([['Thread Turning', 'od', 24], ['Knurling', 'od', 171]]);
    expect(work.offMachine.map((l) => l.process)).not.toContain('Thread Turning');
  });
});

// The Cost tab and the route comparison read the part's threads and knurls through one method, so both price the same lines.
describe('the costing service', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'modules', 'bom-items', 'bom-item-costing.service.ts'), 'utf8');
  const methodOf = (signature: string) => {
    const from = source.indexOf(signature);
    return source.slice(from, source.indexOf('\n  private ', from + 1));
  };

  it('the cost summary and the turned route comparison both take a turned part\'s threads from resolveTurnedThreading', () => {
    const costInput = source.slice(source.indexOf('const baseCncInput: Omit<MachiningCostInput'), source.indexOf('// ── Multi-Spindle Machining'));
    expect(costInput).toContain('isTurnedFamily(family) ? this.resolveTurnedThreading(item, fg)');
    expect(methodOf('private async buildTurnedRoutes(')).toContain('...this.resolveTurnedThreading(item, fg),');
    // The multi-spindle times the cost summary's input (req.turning), threads and knurls with it.
    expect(source).toContain('turning: baseCncInput,');
  });
});
