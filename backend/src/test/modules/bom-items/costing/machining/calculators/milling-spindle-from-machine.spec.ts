// The four tool-path milling calculators cap their spindle at the selected machine's own top speed (migration 1150), as every other milling
// calculator does, not at a flat 10 000 rpm: Fine Finish Milling, Contouring, Perimeter Milling and Obround Slot Milling.
//
// Spindle Speed = min(Max Spindle Speed, Cutting Speed x 1000 / (pi x D)): with a 10 mm cutter, 300 m/min asks 9549.3 rpm and 600 m/min
// 19 098.6 rpm. The feed is that speed x teeth x feed per tooth per diameter x D, so the time goes as one over the speed.
//
// Run: npm run test -- milling-spindle-from-machine

import { readFileSync } from 'fs';
import { join } from 'path';
import { runMachiningCalculator, type CalcSeed } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator';
import { loadMachiningCalculatorSpec, specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildMachiningCalculatorMigrationSql } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculators-migration';

const CALCS = specAsCalculators();
const ROOT = join(__dirname, '../../../../../../..');
const seed = (value: number): CalcSeed => ({ value, source: 'test' });
const machine = (rpm: number): Record<string, CalcSeed> => ({ 'Max Spindle Speed': { value: rpm, source: 'Machine: test spindle_speed_rpm' } });
const cutter = (cuttingSpeed: number): Record<string, CalcSeed> => ({
  'Teeth': seed(3), 'Cutting Speed': seed(cuttingSpeed), 'Feed per Tooth per Diameter': seed(0.008),
});

// Each calculator on one face or keyway of a 10 mm cutter, and the path its formulas give it (mm).
const CASES: Array<{ operation: string; seeds: Record<string, CalcSeed>; pathMm: number; passes?: number }> = [
  // 1000 mm2 of floor at a 0.5 stepover = 200 mm, plus 2 x 10 mm of lead.
  { operation: 'Fine Finish Milling', seeds: { 'Floor Area': seed(1000), 'Wall Area': seed(0), 'Faces': seed(1), 'Tool Diameter': seed(10) }, pathMm: 220 },
  // 1000 mm2 of wall at one diameter a step = 100 mm, plus 20 mm of lead.
  { operation: 'Contouring', seeds: { 'Wall Area': seed(1000), 'Surface Area': seed(0), 'Faces': seed(1), 'Tool Diameter': seed(10) }, pathMm: 120 },
  { operation: 'Perimeter Milling', seeds: { 'Wall Area': seed(1000), 'Surface Area': seed(0), 'Faces': seed(1), 'Tool Diameter': seed(10) }, pathMm: 120 },
  // A 40 x 10 x 3.9 mm keyway: 2 passes (3.9 / (0.2 x 10)), each 30 + 1.95 mm; the cutter is the keyway's width.
  { operation: 'Obround Slot Milling', seeds: { 'Keyway Length': seed(40), 'Keyway Width': seed(10), 'Keyway Depth': seed(3.9), 'Keyways': seed(1) }, pathMm: 31.95, passes: 2 },
];

const run = (c: (typeof CASES)[number], cuttingSpeed: number, rpm: number) =>
  runMachiningCalculator(CALCS, c.operation, { ...c.seeds, ...cutter(cuttingSpeed), ...machine(rpm) });
const spindle = (r: ReturnType<typeof run>) => Number(r.trace.find((s) => s.fieldName === 'Spindle Speed')!.value);
const secAt = (c: (typeof CASES)[number], n: number) => ((c.passes ?? 1) * c.pathMm) / (n * 3 * 0.008 * 10) * 60;

describe('the tool-path milling calculators read the machine\'s spindle limit (1150)', () => {
  it('ships in 1150, generated from the spec; the spec sources Max Spindle Speed from the machine on all four', () => {
    expect(readFileSync(join(ROOT, 'migrations/1150_machining_finishing_spindle_from_machine.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1150, loadMachiningCalculatorSpec()));
    for (const c of CASES) {
      const field = loadMachiningCalculatorSpec().calculators.find((x) => x.name === `Machining - ${c.operation}`)!.fields.find((f) => f.name === 'Max Spindle Speed')!;
      expect([c.operation, field.source, field.default]).toEqual([c.operation, 'machine', undefined]);
    }
  });

  describe.each(CASES)('$operation', (c) => {
    it('a machine limit below 10 000 rpm caps the cut there: 6000 rpm for a 9549 rpm cut', () => {
      const r = run(c, 300, 6000);
      expect(r.missing).toEqual([]);
      expect(spindle(r)).toBe(6000);
      expect(r.sec).toBeCloseTo(secAt(c, 6000), 6);
    });

    it('a machine limit above 10 000 rpm is used, not 10 000: a 19 099 rpm cut on a 15 000 rpm machine turns at 15 000', () => {
      const r = run(c, 600, 15000);
      expect(spindle(r)).toBe(15000);
      expect(r.sec).toBeCloseTo(secAt(c, 15000), 6);
      // Quicker than the flat 10 000 rpm the calculator had.
      expect(r.sec!).toBeLessThan(secAt(c, 10000));
    });

    it('a calculated speed below the machine\'s limit is the cut\'s own: 9549 rpm on a 15 000 rpm machine', () => {
      const r = run(c, 300, 15000);
      expect(spindle(r)).toBeCloseTo((300 * 1000) / (Math.PI * 10), 2);
      expect(r.sec).toBeCloseTo(secAt(c, (300 * 1000) / (Math.PI * 10)), 6);
    });

    it('a calculated speed above the machine\'s limit is held to it: 19 099 rpm on a 12 000 rpm machine turns at 12 000', () => {
      const r = run(c, 600, 12000);
      expect(spindle(r)).toBe(12000);
      expect(r.sec).toBeCloseTo(secAt(c, 12000), 6);
    });

    it('with no machine the limit is a named input, never a flat 10 000', () => {
      const r = runMachiningCalculator(CALCS, c.operation, { ...c.seeds, ...cutter(300) });
      expect(r.sec).toBeNull();
      expect(r.missing).toEqual([`${c.operation}: Max Spindle Speed`]);
    });
  });
});
