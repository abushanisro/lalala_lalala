import { describe, expect, it } from 'vitest';

import type { CalculationTraceStep } from '@/lib/api/hooks/useBOMItems';
import { lineWorkingOf, workingNumber, workingOf } from '@/lib/calculators/calculation-working';

const input = (fieldName: string, value: number, unit: string | null): CalculationTraceStep => ({ kind: 'input', fieldName, displayLabel: fieldName, value, unit });
const calc = (fieldName: string, value: number, unit: string | null, formula: string): CalculationTraceStep => ({ kind: 'calculated', fieldName, displayLabel: fieldName, value, unit, formula });

// "Machining - Rough Turning" on a Ø10 x 3.844 mm diameter turned from a 5/8" aluminium bar: the calculator the dialog showed as "0.1 s".
const ROUGH_TURNING = (diameter: number, length: number, v: { radial: number; rough: number; passes: number; rpm: number; feed: number; pass: number; cycle: number }): CalculationTraceStep[] => [
  input('Turned Diameter', diameter, 'mm'),
  input('Turned Length', length, 'mm'),
  input('Bar Diameter', 15.875, 'mm'),
  input('Finish Depth of Cut', 0.8, 'mm'),
  input('Rough Depth of Cut', 1.3, 'mm'),
  input('Rough Cutting Speed', 355, 'm/min'),
  input('Rough Feed', 0.4063, 'mm/rev'),
  calc('Radial Stock', v.radial, 'mm', '({Bar Diameter} - {Turned Diameter}) / 2'),
  calc('Rough Stock', v.rough, 'mm', 'max({Radial Stock} - min({Finish Depth of Cut}, {Radial Stock}), 0)'),
  calc('Rough Passes', v.passes, null, 'round({Rough Stock} / {Rough Depth of Cut})'),
  calc('Spindle Speed', v.rpm, 'rpm', '{Rough Cutting Speed} * 1000 / (pi * {Turned Diameter})'),
  calc('Feed Rate', v.feed, 'mm/min', '{Spindle Speed} * {Rough Feed}'),
  calc('Time per Pass', v.pass, 's', '{Turned Length} / {Feed Rate} * 60'),
  calc('Cycle Time', v.cycle, 's', '{Rough Passes} * {Time per Pass}'),
];
const RING_10 = ROUGH_TURNING(10, 3.844, { radial: 2.9375, rough: 2.1375, passes: 2, rpm: 11300, feed: 4591.19, pass: 0.0502, cycle: 0.1005 });
const RING_12 = ROUGH_TURNING(12, 18.34, { radial: 1.9375, rough: 1.1375, passes: 1, rpm: 9416.67, feed: 3825.99, pass: 0.2876, cycle: 0.2876 });

describe('workingOf: every step behind a calculator result, in the order it is computed', () => {
  it('lists the calculated fields the cycle is built from, each after the ones its formula names', () => {
    expect(workingOf(RING_10).map((s) => s.fieldName)).toEqual([
      'Radial Stock', 'Rough Stock', 'Rough Passes', 'Spindle Speed', 'Feed Rate', 'Time per Pass', 'Cycle Time',
    ]);
  });

  it('writes each formula in field names and again in the numbers used', () => {
    const steps = Object.fromEntries(workingOf(RING_10).map((s) => [s.fieldName, s]));
    expect(steps['Radial Stock']).toMatchObject({ formula: '(Bar Diameter − Turned Diameter) / 2', withValues: '(15.875 − 10) / 2', value: 2.9375, unit: 'mm' });
    expect(steps['Rough Passes']).toMatchObject({ formula: 'round(Rough Stock / Rough Depth of Cut)', withValues: 'round(2.1375 / 1.3)', value: 2 });
    expect(steps['Spindle Speed']).toMatchObject({ formula: 'Rough Cutting Speed × 1000 / (π × Turned Diameter)', withValues: '355 × 1000 / (π × 10)', unit: 'rpm' });
    expect(steps['Cycle Time']).toMatchObject({ formula: 'Rough Passes × Time per Pass', withValues: '2 × 0.0502', value: 0.1005 });
  });

  it('leaves out a calculated field the result does not use, and an input is never a step', () => {
    const trace = [...RING_10, calc('Machine Cost', 0.004, 'USD', '{Cycle Time} / 3600 * {MHR per Hour}')];
    expect(workingOf(trace).map((s) => s.fieldName)).not.toContain('Machine Cost');
    expect(workingOf(trace).map((s) => s.fieldName)).not.toContain('Turned Diameter');
    expect(workingOf(trace, 'Machine Cost').at(-1)).toMatchObject({ fieldName: 'Machine Cost', withValues: '0.1005 / 3600 × MHR per Hour' });
  });

  it('matches a field named with its unit, keeps the name of a field that has no value, and survives a formula that names itself', () => {
    const trace: CalculationTraceStep[] = [
      input('Cutting Length (mm)', 1200, 'mm'),
      { kind: 'input', fieldName: 'Cutting Speed', displayLabel: 'Cutting Speed', value: null, unit: 'mm/s' },
      calc('Cutting Time', 60, 's', '{Cutting Length} / {Cutting Speed}'),
      calc('Total Time (sec)', 60, 'sec', '{Cutting Time} + {Total Time}'),
    ];
    expect(workingOf(trace).map((s) => [s.fieldName, s.withValues])).toEqual([
      ['Cutting Time', '1200 / Cutting Speed'],
      ['Total Time (sec)', '60 + 60'],
    ]);
  });

  it('has no working for a trace with no calculated result', () => {
    expect(workingOf([input('Turned Diameter', 10, 'mm')])).toEqual([]);
    expect(workingOf(null)).toEqual([]);
    expect(workingOf(RING_10, 'Turned Diameter')).toEqual([]);
  });
});

describe('lineWorkingOf: a line that ran its calculator once per group', () => {
  const prefixed = (label: string, trace: CalculationTraceStep[]): CalculationTraceStep[] =>
    trace.map((s) => ({ ...s, fieldName: `${label} · ${s.fieldName}`, displayLabel: `${label} · ${s.displayLabel}`, group: label, groupField: s.fieldName }));
  // The saved Rough Turning line: two turned diameters, 0.39 s together (the dialog's calculator showed the first alone, 0.1 s).
  const LINE: CalculationTraceStep[] = [
    ...prefixed('Ring Ø10 x 3.84 mm', RING_10),
    ...prefixed('Ring Ø12 x 18.34 mm', RING_12),
    calc('Rough Turning cycle time', 0.3881, 's', 'Sum of every group Cycle Time'),
    input('Setup time', 30, 'min'),
  ];

  it('gives each group its own working, under the calculator\'s field names, and its result', () => {
    const line = lineWorkingOf(LINE);
    expect(line?.groups.map((g) => [g.label, g.result?.value])).toEqual([['Ring Ø10 x 3.84 mm', 0.1005], ['Ring Ø12 x 18.34 mm', 0.2876]]);
    expect(line?.groups[1]?.steps.map((s) => s.fieldName)).toEqual([
      'Radial Stock', 'Rough Stock', 'Rough Passes', 'Spindle Speed', 'Feed Rate', 'Time per Pass', 'Cycle Time',
    ]);
    expect(line?.groups[1]?.steps[0]).toMatchObject({ withValues: '(15.875 − 12) / 2', value: 1.9375 });
  });

  it('gives the line total with the formula the engine recorded, written as the sum of the groups where it is that sum', () => {
    expect(lineWorkingOf(LINE)?.total).toMatchObject({ fieldName: 'Rough Turning cycle time', formula: 'Sum of every group Cycle Time', withValues: '0.1005 + 0.2876', value: 0.3881 });
    // A hole line adds a tool change per group and an allowance: its total is not the groups' sum, so no sum is written.
    const holes = [...LINE.slice(0, -2), calc('Drilling cycle time', 9.4, 's', 'Sum over the groups of (Tool Change Time + No of Uses × Time per Use) + Allowance')];
    expect(lineWorkingOf(holes)?.total).toMatchObject({ value: 9.4, withValues: null });
  });

  it('is null for a line of one run, whose working is the calculator\'s own', () => {
    expect(lineWorkingOf(RING_10)).toBeNull();
    expect(lineWorkingOf(prefixed('Ring Ø10 x 3.84 mm', RING_10))).toBeNull();
    expect(lineWorkingOf(undefined)).toBeNull();
  });
});

describe('workingNumber', () => {
  it('keeps five significant figures below 100 and two decimals from 100 up', () => {
    expect([15.875, 0.4063, 0.0502337, 2, 11300.2826, 4591.3048].map(workingNumber)).toEqual(['15.875', '0.4063', '0.050234', '2', '11300.28', '4591.3']);
  });
});
