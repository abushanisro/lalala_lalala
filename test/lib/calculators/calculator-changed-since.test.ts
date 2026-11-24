import { describe, it, expect } from 'vitest';

import { calculatorChangedSince, type LineCalculation } from '@/lib/calculators/calculator-run';

// Machining - Rigid Tapping as FusionComponent's saved Tapping line kept it (applied 2026-11-23) and as the live engine runs it since the
// workbook's correction (migration 1139, rewritten in place: same id, version 1).
const TAPPING = '1da8063d-a27e-4514-8614-a094ebbf47fd';
const calc = (formulas: Record<string, string>, id = TAPPING, prefix = 'M2 · '): LineCalculation => ({
  calculatorId: id, calculatorVersion: 1,
  calculatorRun: {
    lookupMatches: {},
    trace: [
      { fieldName: `${prefix}Thread Depth`, displayLabel: 'Thread Depth (mm)', kind: 'input', value: 5.01, unit: 'mm', source: 'CAD: tapped hole depth' },
      ...Object.entries(formulas).map(([name, formula]) => ({ fieldName: `${prefix}${name}`, displayLabel: name, kind: 'calculated' as const, value: 1, unit: 's', formula })),
      // A step the engine adds around the calculator, not the calculator's own.
      { fieldName: 'Tapping cycle time', displayLabel: 'Tapping cycle time', kind: 'calculated', value: 8, unit: 's', formula: 'Sum of every thread-size group Cycle Time' },
    ],
  },
} as unknown as LineCalculation);

const OLD = {
  'Spindle Speed': '{Cutting Speed} * 1000 / (pi * {Thread Diameter})',
  'Feed Rate': '{Spindle Speed} * {Thread Pitch}',
  'Time per Thread': '2 * {Thread Depth} / {Feed Rate} * 60',
  'Cycle Time': '{Time per Thread} * {Threads}',
};
const NOW = {
  'Cutting Speed': '{Speed Min} + {Range Position} * ({Speed Max} - {Speed Min})',
  'Spindle Speed': 'min({Max Spindle Speed}, {Cutting Speed} * 1000 / (pi * {Thread Diameter}))',
  'Machining Time': '2 * ({Thread Depth} + {Approach Length}) / ({Thread Pitch} * {Spindle Speed})',
  'Time per Thread': 'ceil({Machining Time} * 60)',
  'Cycle Time': '{Threads} * {Time per Thread}',
};

describe('calculatorChangedSince: a saved line costed with an earlier version of its calculator', () => {
  it('the tapping line saved before the workbook correction: same calculator, same version, other formulas', () => {
    expect(calculatorChangedSince(calc(OLD), calc(NOW))).toBe(true);
  });

  it('a line saved with the calculator as it is now is current, whatever the thread sizes or the engine\'s own steps', () => {
    expect(calculatorChangedSince(calc(NOW, TAPPING, 'M3 · '), calc(NOW, TAPPING, 'M2 · '))).toBe(false);
  });

  it('not comparable, so not flagged: another calculator (another process chosen), no saved run, or a typed cycle', () => {
    expect(calculatorChangedSince(calc(OLD), calc(NOW, 'another-calculator'))).toBe(false);
    expect(calculatorChangedSince(null, calc(NOW))).toBe(false);
    expect(calculatorChangedSince(calc(OLD), null)).toBe(false);
    expect(calculatorChangedSince({ calculatorId: null, calculatorVersion: null, calculatorRun: null }, calc(NOW))).toBe(false);
  });
});
