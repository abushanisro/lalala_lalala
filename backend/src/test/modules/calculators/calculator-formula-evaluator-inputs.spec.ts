import { evaluateCalculatorFormulas } from '../../../modules/calculators/calculator-formula-evaluator';
import { loadMachiningCalculatorSpec, specFieldToRow } from '../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';

// The Edit Process Cost dialog runs a calculator on the inputs in its boxes. A box the engineer cleared arrived as 0 (or ''), and the
// Rigid Tapping calculator then capped its spindle at 0 rpm: Machining Time = 2 x (depth + 4) / (pitch x 0) = Infinity, returned as a
// result that JSON sent as null, so the dialog showed "Cycle Time (s) ... N/A" with no reason.
const tapping = loadMachiningCalculatorSpec().calculators.find((c) => c.name === 'Machining - Rigid Tapping')!;
const fields = tapping.fields.map((f, i) => ({ ...specFieldToRow(f, i + 1), id: f.name }));
// R_M-0230-030 MOTOR MOUNT's M3 group on the Makino V22: 14 threads, the engine's inputs.
const M3 = {
  'Thread Diameter': 3, 'Thread Depth': 6.5, Threads: 14, 'Thread Pitch': 0.5, 'Speed Min': 4.6, 'Speed Max': 7.6, 'Max Spindle Speed': 15000,
};
const run = (inputs: Record<string, unknown>) => evaluateCalculatorFormulas(fields as never, [], inputs).results;

describe('a calculator run on the dialog\'s inputs', () => {
  it('times the M3 threads on the inputs the engine used', () => {
    const r = run(M3);
    expect(typeof r['Cycle Time']).toBe('number');
    expect(r['Cycle Time']).toBeGreaterThan(0);
  });

  it('a cleared box is no value: the field is named as missing, and what reads it says it could not be calculated', () => {
    for (const cleared of ['', null, '  ']) {
      const r = run({ ...M3, 'Max Spindle Speed': cleared });
      expect(r['Spindle Speed']).toEqual({ error: 'Max Spindle Speed has no value: enter it', value: null });
      expect(r['Machining Time']).toEqual({ error: 'needs Spindle Speed, which could not be calculated', value: null });
      expect(r['Cycle Time']).toEqual({ error: 'needs Time per Thread, which could not be calculated', value: null });
    }
  });

  it('a cleared box with a default takes the default (Approach Length 4 mm)', () => {
    expect(run({ ...M3, 'Approach Length': '' })['Cycle Time']).toBe(run(M3)['Cycle Time']);
  });

  it('a result that is not a finite number is an error naming the input at 0, never a number', () => {
    const r = run({ ...M3, 'Max Spindle Speed': 0 });
    expect(r['Spindle Speed']).toBe(0);
    expect(r['Machining Time']).toEqual({ error: 'Machining Time is Infinity: Spindle Speed is 0', value: null });
    expect(r['Cycle Time']).toEqual({ error: 'needs Time per Thread, which could not be calculated', value: null });
  });
});
