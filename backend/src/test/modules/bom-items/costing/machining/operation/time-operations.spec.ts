// A part's operations are planned once, before any machine is chosen (the operation sequencer), and timed on each route's machine
// (timeOperations): a calculator caps its spindle at the machine's own limit, so one operation takes a different time on each machine.
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import type { CalcSeed } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator';
import { timeOperations } from '../../../../../../modules/bom-items/costing/machining/operation/time-operations';
import type { OperationLine } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import {
  computeDrillCycle, computeMillingCostSummary, type MachiningCostInput, type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import { workbookFixture } from '../workbook-fixture';

const CALCS = specAsCalculators();
const seed = (value: number): CalcSeed => ({ value, source: 'test' });
// A 9.971 x 4 x 2.951 mm keyway in aluminium (the tblMillingFinishing row): 4 passes of 6.70875 mm; at the calculator's own 10 000 rpm
// the feed is 10 000 x 3 x 0.008 x 4 = 960 mm/min and the cut 4 x 6.70875 / 960 x 60 = 1.6772 s.
const KEYWAY: OperationLine = {
  name: 'Obround Slot Milling', timeSec: 1.6772, source: 'feature', cadFeatureType: 'Keyway',
  plan: [{
    operation: 'Obround Slot Milling',
    seeds: {
      'Keyway Length': seed(9.971), 'Keyway Width': seed(4), 'Keyway Depth': seed(2.951), 'Keyways': seed(1),
      'Teeth': seed(3), 'Cutting Speed': seed(183), 'Feed per Tooth per Diameter': seed(0.008),
    },
  }],
};
const machine = (rpm: number): Record<string, CalcSeed> => ({ 'Max Spindle Speed': seed(rpm) });

describe('timeOperations', () => {
  it('with no machine, an operation is timed as it was planned', () => {
    const [timed] = timeOperations([KEYWAY], CALCS);
    expect(timed!.timeSec).toBeCloseTo(1.6772, 3);
    expect(timed!.calculator?.id).toBe('Machining - Obround Slot Milling');
  });

  it('on a machine, its spindle limit caps the cut: 6000 rpm feeds 576 mm/min, 2.7953 s', () => {
    const [timed] = timeOperations([KEYWAY], CALCS, machine(6000));
    expect(timed!.timeSec).toBeCloseTo((4 * 6.70875 / 576) * 60, 4);
    expect(timed!.trace!.find((s) => s.fieldName === 'Spindle Speed')).toMatchObject({ value: 6000 });
  });

  it('keeps the drawing\'s factor on a re-timed operation (a fine surface finish: x 1.3)', () => {
    const [timed] = timeOperations([{ ...KEYWAY, timeSec: KEYWAY.timeSec * 1.3, timeFactor: 1.3 }], CALCS, machine(6000));
    expect(timed!.timeSec).toBeCloseTo((4 * 6.70875 / 576) * 60 * 1.3, 4);
  });

  it('a stepped hole is one run per step, each under its step\'s name, then their sum', () => {
    const step = (d: number, depth: number) => ({ ...computeDrillCycle(d, 'Aluminum, ANSI 6061', depth, workbookFixture(), CALCS).plan!, label: `Step Ø${d}` });
    const plan = [step(6, 10), step(10, 5)];
    const [timed] = timeOperations([{ name: 'Drilling', timeSec: 0, source: 'feature', plan }], CALCS);
    const each = plan.map((p) => computeDrillCycle(Number(p.seeds['Hole Diameter']!.value), 'Aluminum, ANSI 6061', Number(p.seeds['Hole Depth']!.value), workbookFixture(), CALCS).sec!);
    expect(timed!.timeSec).toBeCloseTo(each[0]! + each[1]!, 6);
    expect(timed!.trace!.some((s) => s.fieldName.startsWith('Step Ø6 ·'))).toBe(true);
    expect(timed!.trace!.at(-1)).toMatchObject({ fieldName: 'Drilling cycle time', kind: 'calculated' });
  });

  it('an operation with no plan (a fixed allowance) is as it was', () => {
    const deburr: OperationLine = { name: 'Deburr', timeSec: 90, source: 'fixed' };
    expect(timeOperations([deburr], CALCS, machine(6000))).toEqual([deburr]);
  });

  it('a plan whose inputs are short stays a named gap', () => {
    const short: OperationLine = { ...KEYWAY, plan: [{ operation: 'Obround Slot Milling', seeds: { 'Keyway Width': seed(4) } }] };
    const [timed] = timeOperations([short], CALCS, machine(6000));
    expect(timed!.timeSec).toBe(0);
    expect(timed!.missing).toContain('Keyway Length');
  });
});

describe('each mill route times the part\'s operations on its own spindle', () => {
  const rate = (rpm: number): MHRRateInput =>
    ({ rate: 900, source: 'mhr_database', machineClass: '3_axis_mill', machineName: `Mill ${rpm}`, commodityCode: null, maxSpindleRpm: rpm } as MHRRateInput);
  const input = (rpm: number) => ({
    volume: 40_000, surfaceArea: 8000, maxLength: 100, maxWidth: 50, maxHeight: 20, holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5, materialDensityKgM3: 2700, materialSource: 'db', threads: [],
    tightestToleranceMm: null, gdtFeatureCount: 0, batchSize: 10, family: 'milled', finishedWeightKg: 0.1,
    mhrRate: rate(rpm), tappingRate: rate(rpm), deburrRate: rate(rpm), inspectionRate: rate(rpm), surfaceTreatment: null,
    machiningCalculators: CALCS, featureOps: [KEYWAY],
  } as unknown as MachiningCostInput);
  const millMinutes = (rpm: number) =>
    computeMillingCostSummary(input(rpm), '3_axis_mill' as MachineClassId).processLines.find((l) => l.process === '3 Axis Mill')!.cycleTimeMin;

  it('the machine\'s limit replaces the calculator\'s 10 000 rpm default: 6000 rpm is 2.7953 s, 12 000 rpm 1.3977 s, plus the mill line\'s 15 %', () => {
    // 6000 rpm: 4 x 6.70875 / (6000 x 0.096 = 576 mm/min) x 60 = 2.7953 s.  12 000 rpm: 4 x 6.70875 / 1152 x 60 = 1.3977 s.
    // The mill line adds its stored rapids and tool-change allowance, 15 % (Machining - Milling).
    expect(millMinutes(6000) * 60).toBeCloseTo(((4 * 6.70875) / 576) * 60 * 1.15, 1);
    expect(millMinutes(12000) * 60).toBeCloseTo(((4 * 6.70875) / 1152) * 60 * 1.15, 1);
  });
});
