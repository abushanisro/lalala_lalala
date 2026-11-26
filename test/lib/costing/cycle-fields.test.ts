import { describe, expect, it } from 'vitest';

import type { CalculationTraceStep } from '@/lib/api/hooks/useBOMItems';
import { cycleFields, formatFieldValue, runsSetTogether, summedOperations } from '@/lib/costing/cycle-fields';

// The Cost panel's Cycle section: the line's Cycle Time, the phases its formula adds up (shown first, editable), and every other field of the calculation.
const input = (fieldName: string, value: number, unit: string | null, source: string): CalculationTraceStep => ({ fieldName, displayLabel: fieldName, kind: 'input', value, unit, source });
const calc = (fieldName: string, value: number, unit: string | null, formula: string): CalculationTraceStep => ({ fieldName, displayLabel: fieldName, kind: 'calculated', value, unit, formula });

const trace: CalculationTraceStep[] = [
  input('Nominal Wall Thickness', 1.5, 'mm', 'CAD nominal wall thickness'),
  input('Press Dry Cycle Time', 1.18, 's', 'Press reference record'),
  input('Cycle Time Adjustment Factor', 1, null, 'variables: cycleTimeAdjustmentFactor'),
  calc('Thermal Diffusivity', 0.08, 'mm²/s', '{Thermal Conductivity of Melt} / 2'),
  calc('Cooling Time', 2.9, 's', 'floor({Nominal Wall Thickness} * 2)'),
  calc('Fill Time', 0.12, 's', '{Shot Melt Volume} / {Press Injection Rate}'),
  calc('Cycle Time', 4.2, 's', '({Fill Time} + {Cooling Time} + {Press Dry Cycle Time}) * {Cycle Time Adjustment Factor}'),
];

describe('cycleFields', () => {
  it('splits the calculation into the cycle, its phases in formula order, and the rest in calculator order', () => {
    const f = cycleFields(trace);
    if (!f) throw new Error('no cycle');
    expect(f.cycle.fieldName).toBe('Cycle Time');
    expect(f.phases.map((s) => s.fieldName)).toEqual(['Fill Time', 'Cooling Time', 'Press Dry Cycle Time', 'Cycle Time Adjustment Factor']);
    expect(f.others.map((s) => s.fieldName)).toEqual(['Nominal Wall Thickness', 'Thermal Diffusivity']);
  });

  it('is null without a Cycle Time (or Total Time) in the calculation', () => {
    expect(cycleFields([])).toBeNull();
    expect(cycleFields([input('A', 1, 's', 'x')])).toBeNull();
  });
});

describe('formatFieldValue', () => {
  it('keeps the precision a phase needs: 2.9 s is not 3 s, 1.18 s is not 1 s', () => {
    expect(formatFieldValue(2.9)).toBe('2.9');
    expect(formatFieldValue(1.18)).toBe('1.18');
    expect(formatFieldValue(0.0797238)).toBe('0.0797');
    expect(formatFieldValue(784.61)).toBe('784.61');
    expect(formatFieldValue(null)).toBe('—');
  });
});

describe('cycleFields for another result (a tooling cost)', () => {
  const tooling: CalculationTraceStep[] = [
    input('Design Hours', 3.24, 'h', 'cmMoldBaseDesignHours'),
    calc('Design Cost', 209.73, 'USD', '{Design Hours} * {Design Rate}'),
    calc('Mold Cost', 4538.67, 'USD', '{Purchased Components Cost} + {Design Cost}'),
    calc('Tooling Investment', 4538.67, 'USD', '{Mold Cost} * {Molds Required}'),
    calc('Tooling Cost Per Part', 0.1513, 'USD', '{Tooling Investment} / {Parts}'),
  ];
  it('takes the named result and the named fields first', () => {
    const f = cycleFields(tooling, { result: 'Tooling Cost Per Part', first: ['Design Cost', 'Tooling Investment'] });
    if (!f) throw new Error('no result');
    expect(f.cycle.fieldName).toBe('Tooling Cost Per Part');
    expect(f.phases.map((s) => s.fieldName)).toEqual(['Design Cost', 'Tooling Investment']);
    expect(f.others.map((s) => s.fieldName)).toEqual(['Design Hours', 'Mold Cost']);
  });
});

// A mill line: its calculator adds up the times of the operations sequenced on the part, each timed by a calculator of its own. The line's steps come
// first, then each operation's under its name, numbered by its place in the sequence (two pockets rough milled are two operations of one name).
describe('a line that adds up operations of their own (a mill line)', () => {
  const ROUGH = { calculator: 'Machining - Rough Milling' };
  const pocket = (operation: number, length: number, depth: number, seconds: number): CalculationTraceStep[] => [
    { ...input('Rough Milling · Cut Length', length, 'mm', 'CAD: pocket length'), group: 'Rough Milling', groupField: 'Cut Length', operation, ref: { kind: 'features', label: 'Pocket', features: [{ featureId: `p${operation}` }] } },
    { ...input('Rough Milling · Cut Depth', depth, 'mm', 'CAD: depth'), group: 'Rough Milling', groupField: 'Cut Depth', operation, ref: { kind: 'features', label: 'Pocket', features: [{ featureId: `p${operation}` }] } },
    { ...input('Rough Milling · Depth of Cut', 2, 'mm', 'End Milling sheet: 2 mm'), group: 'Rough Milling', groupField: 'Depth of Cut', operation, settable: { ...ROUGH, field: 'Depth of Cut' }, ref: { kind: 'calculatorField', calculator: ROUGH.calculator, field: 'Depth of Cut', defaults: [] } },
    { ...calc('Rough Milling · Cycle Time', seconds, 's', '{Cuts} * {Time per Cut}'), group: 'Rough Milling', groupField: 'Cycle Time', operation },
  ];
  const mill: CalculationTraceStep[] = [
    { ...input('Facing Time', 38, 's', 'CAD features: Facing (operation sequence)'), sumOf: [{ operation: 0, name: 'Facing', seconds: 38 }] },
    {
      ...input('Rough Milling Time', 109.44, 's', 'CAD features: Bulk Milling, Rough Milling (operation sequence)'),
      sumOf: [{ operation: 1, name: 'Bulk Milling', seconds: 48.4378 }, { operation: 2, name: 'Rough Milling', seconds: 58, count: 1 }, { operation: 3, name: 'Rough Milling', seconds: 3, count: 1, factor: 1.3 }],
    },
    input('Contouring Time', 0, 's', 'CAD features: none of this group on the part'),
    { ...input('Tool Change Time', 4.2, 's', 'Haas VF-2 specification'), settable: { calculator: 'Machining - Milling', field: 'Tool Change Time' } },
    input('Tools', 7, null, 'Operation sequence'),
    calc('Cutting Time', 147.44, 's', '{Facing Time} + {Rough Milling Time} + {Contouring Time}'),
    calc('Tool Change Time Total', 29.4, 's', '{Tools} * {Tool Change Time}'),
    calc('Cycle Time', 176.84, 's', '{Cutting Time} + {Tool Change Time Total}'),
    { ...input('Facing · Face Length', 35.4, 'mm', 'Stock'), group: 'Facing', groupField: 'Face Length', operation: 0 },
    { ...calc('Facing · Cycle Time', 38, 's', '{Faces} * {Time per Face}'), group: 'Facing', groupField: 'Cycle Time', operation: 0 },
    { ...input('Bulk Milling · Removed Volume', 8423.96, 'mm^3', 'Stock around the part'), group: 'Bulk Milling', groupField: 'Removed Volume', operation: 1, ref: { kind: 'calculation', name: 'Stock around the part', evidence: null, steps: [] } },
    { ...calc('Bulk Milling · Cycle Time', 48.4378, 's', '{Removed Volume} / {Material Removal Rate} * 60'), group: 'Bulk Milling', groupField: 'Cycle Time', operation: 1 },
    ...pocket(2, 33, 19, 58),
    ...pocket(3, 5, 3.5, 3),
  ];
  const fields = cycleFields(mill);
  if (!fields) throw new Error('no cycle');
  const [, roughTime, contouringTime] = mill;
  if (!roughTime || !contouringTime) throw new Error('no time inputs');
  /** The three operations of the Rough Milling Time: the bulk milling, the wide pocket, the narrow pocket. */
  const operations = () => {
    const [bulk, wide, narrow] = summedOperations(mill, roughTime);
    if (!bulk || !wide || !narrow) throw new Error('not three operations');
    return { all: [bulk, wide, narrow], bulk, wide, narrow };
  };

  it('the line\'s own fields leave out the operations\' steps: they belong under the time that adds them', () => {
    expect(fields.cycle.value).toBe(176.84);
    expect(fields.phases.map((s) => s.fieldName)).toEqual(['Cutting Time', 'Tool Change Time Total']);
    expect(fields.others.map((s) => s.fieldName)).toEqual(['Contouring Time', 'Tool Change Time', 'Tools']);
  });

  it('a phase lists under it the times its formula adds that have operations; a time with none stays among the other fields', () => {
    expect(fields.summed.get('Cutting Time')?.map((s) => s.fieldName)).toEqual(['Facing Time', 'Rough Milling Time']);
    expect(fields.summed.has('Tool Change Time Total')).toBe(false);
  });

  it('a time opens its operations in sequence order, each with its time and its own steps under their own names', () => {
    const { all, wide, narrow } = operations();
    expect(all.map((o) => [o.name, o.seconds, o.count, o.factor])).toEqual([['Bulk Milling', 48.4378, null, null], ['Rough Milling', 58, 1, null], ['Rough Milling', 3, 1, 1.3]]);
    expect(all.reduce((t, o) => t + o.seconds, 0)).toBeCloseTo(109.44, 2);
    expect(wide.steps.map((s) => s.fieldName)).toEqual(['Cut Length', 'Cut Depth', 'Depth of Cut', 'Cycle Time']);
    expect(wide.steps.find((s) => s.fieldName === 'Cut Length')?.value).toBe(33);
    expect(narrow.steps.find((s) => s.fieldName === 'Cut Length')?.value).toBe(5);
  });

  it('two operations of one name are told apart by what was measured on the part for each, not by a parameter', () => {
    const { bulk, wide, narrow } = operations();
    expect(bulk.measured.map((s) => s.fieldName)).toEqual(['Removed Volume']);
    expect(wide.measured.map((s) => [s.fieldName, s.value])).toEqual([['Cut Length', 33], ['Cut Depth', 19]]);
    expect(narrow.measured.map((s) => [s.fieldName, s.value])).toEqual([['Cut Length', 5], ['Cut Depth', 3.5]]);
  });

  it('a parameter the engineer set for the part is not taken for a measurement, though it opens as a calculation (the value it replaced)', () => {
    const set = mill.map((s): CalculationTraceStep => (s.groupField === 'Depth of Cut'
      ? { ...s, value: 4, override: { original: 2, reason: 'rigid fixture' }, ref: { kind: 'calculation', name: 'Depth of Cut: set by the engineer on this part', evidence: null, steps: [] } }
      : s));
    const [, wide] = summedOperations(set, roughTime);
    expect(wide?.measured.map((s) => s.fieldName)).toEqual(['Cut Length', 'Cut Depth']);
  });

  it('a step that adds up nothing has no operations', () => {
    expect(summedOperations(mill, contouringTime)).toEqual([]);
    expect(summedOperations(mill, fields.cycle)).toEqual([]);
  });

  it('a part\'s own value for a field is used by every calculation of that calculator: both pockets\' Depth of Cut are set together', () => {
    expect(runsSetTogether(mill, { ...ROUGH, field: 'Depth of Cut' })).toBe(2);
    expect(runsSetTogether(mill, { calculator: 'Machining - Milling', field: 'Tool Change Time' })).toBe(1);
    expect(runsSetTogether(mill, { ...ROUGH, field: 'Cut Length' })).toBe(0);
  });

  it('a calculation saved before operations were numbered is laid out as it was: every step a field of the line', () => {
    const before = mill.map(({ operation: _operation, sumOf: _sumOf, ...s }) => s);
    const f = cycleFields(before);
    if (!f) throw new Error('no cycle');
    expect(f.summed.size).toBe(0);
    expect(f.others).toHaveLength(before.length - 3);
  });
});
