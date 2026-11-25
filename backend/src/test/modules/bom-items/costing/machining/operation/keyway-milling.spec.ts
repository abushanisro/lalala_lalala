// A keyway that is milled (not broached) is timed as what cuts it: an end mill of the keyway's own width, taking the slot in shallow passes
// between its two end centres. It was timed as its removed volume at the material's bulk removal rate, the rate of a large cutter in open
// material: a 4 mm wide, 9.97 mm long, 2.95 mm deep keyway (107.91 mm^3) in aluminium at 60 000 mm^3/min came to 0.14 s.
//
// The stored calculator "Machining - Obround Slot Milling" (the catalog's operation for a Keyway on the mills and the live-tool lathes):
//
//   Spindle Speed = min(Max Spindle Speed, Cutting Speed * 1000 / (pi * Keyway Width))                          [rpm]
//   Feed Rate     = Spindle Speed * Teeth * Feed per Tooth per Diameter * Keyway Width                          [mm/min]
//   Passes        = ceil(Keyway Depth / (Slotting Depth Ratio * Keyway Width))
//   Path per Pass = max(Keyway Length - Keyway Width, 0) + Keyway Depth / Passes                                [mm]
//   Cycle Time    = Keyways * Passes * Path per Pass / Feed Rate * 60                                           [s]
//
// Slotting Depth Ratio 1 (a pass as deep as the cutter is wide: the Corrax end milling table on the workbook's Slot Milling sheet,
// migration 1158) is the calculator's default; Max Spindle Speed is the machine's own top speed (migration 1150), here a
// 10 000 rpm test mill. Cutting Speed, Teeth and Feed per Tooth per
// Diameter are the material class's tblMillingFinishing row: aluminium 183 m/min, 3 teeth, 0.008; mild steel 76 m/min, 4 teeth, 0.008.
// Every expected number below is worked out by hand from these.
import { runMachiningCalculator, type CalcSeed } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator';
import { loadMachiningCalculatorSpec, specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import {
  buildOperationSequence,
  injectDrawingIntelligence,
  KEYWAY_MILLING,
  type MillingFinishingRow,
  type OperationLine,
} from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import {
  computeMillingCostSummary,
  type MachineClassId,
  type MachiningCostInput,
  type MaterialClass,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { isReferenceOperation } from '../../../../../../modules/bom-items/costing/shared/reference-features.generated';

import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import { timeOperations } from '../../../../../../modules/bom-items/costing/machining/operation/time-operations';
import { workbookFixture } from '../workbook-fixture';

const CALCS = specAsCalculators();
// Every route times its operations on its own machine (timeOperations): here a 10 000 rpm test mill.
const TEST_MACHINE = { 'Max Spindle Speed': { value: 10000, source: 'Machine: test spindle_speed_rpm' } };
const cutter = (teeth: number, cuttingSpeedMPerMin: number, feedPerToothPerDiameter: number): MillingFinishingRow => ({ toolDiameterMm: 10, teeth, cuttingSpeedMPerMin, feedPerToothPerDiameter });
const ALUMINIUM = cutter(3, 183, 0.008);
const MILD_STEEL = cutter(4, 76, 0.008);
const REMOVAL_RATE: Partial<Record<MaterialClass, number>> = { aluminum: 60000, mild_steel: 12000 };

/** The calculator run on a keyway of this size, with the material's cutter row. */
function run(lengthMm: number, widthMm: number, depthMm: number, row: MillingFinishingRow = ALUMINIUM, keyways = 1, extra: Record<string, CalcSeed> = {}) {
  const seed = (value: number): CalcSeed => ({ value, source: 'test' });
  return runMachiningCalculator(CALCS, 'Obround Slot Milling', {
    'Keyway Length': seed(lengthMm), 'Keyway Width': seed(widthMm), 'Keyway Depth': seed(depthMm), 'Keyways': seed(keyways),
    'Teeth': seed(row.teeth), 'Cutting Speed': seed(row.cuttingSpeedMPerMin), 'Feed per Tooth per Diameter': seed(row.feedPerToothPerDiameter),
    ...TEST_MACHINE,
    ...extra,
  });
}
const stepOf = (r: { trace: OperationLine['trace'] }, field: string) => r.trace!.find((s) => s.fieldName === field)?.value;

describe('Machining - Obround Slot Milling: the calculator, by hand', () => {
  it('is the catalog\'s operation for a Keyway, under the name the engine uses for it', () => {
    expect(KEYWAY_MILLING).toBe('Obround Slot Milling');
    expect(isReferenceOperation('machining', 'Keyway', KEYWAY_MILLING)).toBe(true);
    expect(CALCS[KEYWAY_MILLING]?.name).toBe('Machining - Obround Slot Milling');
  });

  it('the shaft\'s keyway in aluminium: 10 000 rpm (the limit), 960 mm/min, 1 pass of 8.922 mm = 0.56 s', () => {
    // 183 000 / (pi x 4) = 14 563 rpm, held to 10 000. Feed 10 000 x 3 x 0.008 x 4 = 960 mm/min. Passes ceil(2.951 / (1 x 4)) = ceil(0.74) = 1.
    // Path 9.971 - 4 + 2.951 / 1 = 5.971 + 2.951 = 8.922 mm. Time 1 x 8.922 / 960 x 60 = 0.557625 s.
    const r = run(9.971, 4, 2.951);
    expect(r.missing).toEqual([]);
    expect(stepOf(r, 'Spindle Speed')).toBe(10000);
    expect(stepOf(r, 'Feed Rate')).toBe(960);
    expect(stepOf(r, 'Passes')).toBe(1);
    expect(stepOf(r, 'Path per Pass')).toBeCloseTo(8.922, 4);
    expect(r.sec).toBeCloseTo(0.557625, 9);
    // Four times the 0.14 s the bulk removal rate gave it.
    expect(r.sec! / 0.1403).toBeGreaterThan(3.9);
  });

  it('the same keyway in mild steel: 6048 rpm, 774 mm/min, the same 1 pass = 0.69 s', () => {
    // 76 000 / (pi x 4) = 6047.89 rpm, under the limit. Feed 6047.89 x 4 x 0.008 x 4 = 774.13 mm/min. Time 1 x 8.922 / 774.13 x 60 = 0.6915 s.
    const r = run(9.971, 4, 2.951, MILD_STEEL);
    expect(stepOf(r, 'Spindle Speed')).toBeCloseTo(6047.89, 2);
    expect(stepOf(r, 'Feed Rate')).toBeCloseTo(774.13, 2);
    expect(stepOf(r, 'Passes')).toBe(1);
    expect(r.sec).toBeCloseTo(0.6915, 4);
    expect(r.sec).toBeCloseTo(8.922 / ((76000 / (Math.PI * 4)) * 4 * 0.008 * 4) * 60, 9);
  });

  it('a keyway shorter than its width has no travel: each pass is its plunge only', () => {
    // 3 long, 4 wide, 1.6 deep: passes ceil(1.6 / 4) = 1; path max(3 - 4, 0) + 1.6 / 1 = 1.6 mm; 1 x 1.6 / 960 x 60 = 0.1 s.
    const r = run(3, 4, 1.6);
    expect(stepOf(r, 'Passes')).toBe(1);
    expect(stepOf(r, 'Path per Pass')).toBeCloseTo(1.6, 9);
    expect(r.sec).toBeCloseTo(0.1, 9);
    // A keyway as long as it is wide (a plunged hole) is the same: no travel either.
    expect(run(4, 4, 1.6).sec).toBeCloseTo(0.1, 9);
  });

  it('a depth that is an exact number of passes takes that number, not one more', () => {
    // 12 long, 4 wide, 8 deep: 8 / 4 = 2 passes exactly; path 8 + 4 = 12 mm; 2 x 12 / 960 x 60 = 1.5 s.
    const r = run(12, 4, 8);
    expect(stepOf(r, 'Passes')).toBe(2);
    expect(r.sec).toBeCloseTo(1.5, 9);
    // A hair deeper is a third pass: 3 x (8 + 8.01 / 3) / 960 x 60 = (24 + 8.01) / 16 = 2.000625 s.
    const deeper = run(12, 4, 8.01);
    expect(stepOf(deeper, 'Passes')).toBe(3);
    expect(deeper.sec).toBeCloseTo(2.000625, 9);
    // A depth of one pass or less is one pass: 0.5 deep, (8 + 0.5) / 960 x 60 = 0.53125 s.
    expect(stepOf(run(12, 4, 0.5), 'Passes')).toBe(1);
    expect(run(12, 4, 0.5).sec).toBeCloseTo(0.53125, 9);
  });

  it('an exact number of passes stays exact where binary arithmetic does not: 4.2 deep at 1.4 wide is three passes, 5.4 at 0.6 is nine', () => {
    // 4.2 / (1 x 1.4) and 5.4 / (1 x 0.6) come out a few parts in 10^16 above 3 and 9: rounding those up would add a pass.
    expect(4.2 / (1 * 1.4)).toBeGreaterThan(3);
    expect(5.4 / (1 * 0.6)).toBeGreaterThan(9);
    expect(stepOf(run(10, 1.4, 4.2), 'Passes')).toBe(3);
    expect(stepOf(run(10, 0.6, 5.4), 'Passes')).toBe(9);
  });

  it('several identical keyways take that many times one', () => {
    expect(run(9.971, 4, 2.951, ALUMINIUM, 2).sec).toBeCloseTo(2 * 0.557625, 9);
    expect(run(9.971, 4, 2.951, MILD_STEEL, 3).sec).toBeCloseTo(3 * run(9.971, 4, 2.951, MILD_STEEL).sec!, 9);
  });

  it('a wide keyway turns the cutter below the spindle limit, at the material\'s cutting speed', () => {
    // 20 wide in aluminium: 183 000 / (pi x 20) = 2912.5 rpm. Feed 2912.5 x 3 x 0.008 x 20 = 1398 mm/min. 60 long, 6 deep: passes
    // ceil(6 / 20) = 1; path 40 + 6 = 46 mm; 1 x 46 / 1398 x 60 = 1.974 s.
    const r = run(60, 20, 6);
    expect(stepOf(r, 'Spindle Speed')).toBeCloseTo(2912.54, 2);
    expect(stepOf(r, 'Passes')).toBe(1);
    expect(r.sec).toBeCloseTo(46 / ((183000 / (Math.PI * 20)) * 3 * 0.008 * 20) * 60, 9);
    expect(r.sec).toBeCloseTo(1.974, 3);
  });

  it('its one default is the calculator\'s own, shown as such; the spindle limit is the machine\'s; the depth of a pass has its source in the spec', () => {
    const r = run(9.971, 4, 2.951);
    // The calculator's own value: its source is the spec's note for the field, and it opens the calculator's table of defaults.
    const assumed = loadMachiningCalculatorSpec().calculators.find((c) => c.name === 'Machining - Obround Slot Milling')!.fields.find((f) => f.name === 'Slotting Depth Ratio')!.note!;
    expect(r.trace.find((s) => s.fieldName === 'Slotting Depth Ratio')).toMatchObject({ kind: 'input', value: 1, source: assumed });
    expect(r.trace.find((s) => s.fieldName === 'Max Spindle Speed')).toMatchObject({ kind: 'input', value: 10000, source: 'Machine: test spindle_speed_rpm' });
    const field = loadMachiningCalculatorSpec().calculators.find((c) => c.name === 'Machining - Obround Slot Milling')!.fields.find((f) => f.name === 'Slotting Depth Ratio')!;
    expect(field.default).toBe(1);
    expect(field.note).toContain("'Slot milling, Axial depth of cut, ap = 1 x D'");
    expect(field.note).toContain('Mitsubishi Materials');
    // The spindle limit is the machine's, on the keyway and the finishing passes alike (migration 1150): no flat 10 000 rpm.
    for (const name of ['Machining - Obround Slot Milling', 'Machining - Fine Finish Milling', 'Machining - Contouring', 'Machining - Perimeter Milling']) {
      const field = loadMachiningCalculatorSpec().calculators.find((c) => c.name === name)!.fields.find((f) => f.name === 'Max Spindle Speed')!;
      expect([name, field.source, field.default]).toEqual([name, 'machine', undefined]);
    }
  });

  it('with no machine the spindle limit is a named input, never a stand-in', () => {
    const noMachine = runMachiningCalculator(CALCS, 'Obround Slot Milling', {
      'Keyway Length': { value: 9.971, source: 'test' }, 'Keyway Width': { value: 4, source: 'test' }, 'Keyway Depth': { value: 2.951, source: 'test' }, 'Keyways': { value: 1, source: 'test' },
      'Teeth': { value: 3, source: 'test' }, 'Cutting Speed': { value: 183, source: 'test' }, 'Feed per Tooth per Diameter': { value: 0.008, source: 'test' },
    });
    expect(noMachine.sec).toBeNull();
    expect(noMachine.missing).toEqual(['Obround Slot Milling: Max Spindle Speed']);
  });

  it('a shallower pass is the engineer\'s to set: half the ratio is twice the passes', () => {
    // Ratio 0.1: ceil(2.951 / 0.4) = 8 passes of 5.971 + 2.951 / 8 mm; (8 x 5.971 + 2.951) / 960 x 60 = 3.1699 s.
    const r = run(9.971, 4, 2.951, ALUMINIUM, 1, { 'Slotting Depth Ratio': { value: 0.1, source: 'test' } });
    expect(stepOf(r, 'Passes')).toBe(8);
    expect(r.sec).toBeCloseTo((8 * 5.971 + 2.951) / 960 * 60, 9);
  });

  it('a keyway with no measurement, or no cutter data, has no time: the calculator names what it lacks', () => {
    const noCutter = runMachiningCalculator(CALCS, 'Obround Slot Milling', {
      'Keyway Length': { value: 9.971, source: 'test' }, 'Keyway Width': { value: 4, source: 'test' }, 'Keyway Depth': { value: 2.951, source: 'test' }, 'Keyways': { value: 1, source: 'test' },
    });
    expect(noCutter.sec).toBeNull();
    expect(noCutter.missing).toEqual(['Obround Slot Milling: Teeth, Cutting Speed, Feed per Tooth per Diameter, Max Spindle Speed']);
  });
});

// ── The sequencer ────────────────────────────────────────────────────────────

// The Lead Screw side shaft's closed keyway, as feature_graph_v2 stores it.
const SHAFT_KEYWAY = {
  face_ids: [13, 14, 15, 25, 26], material_removed_mm3: 107.91, depth_mm: 2.951, walled_fraction: 1.0, width_confined: true,
  length_mm: 9.971, width_mm: 4.0, extents_mm: [10.005, 4.0, 2.951],
};
const keywayFeature = (id: string, ...occurrences: object[]) => ({ id, feature_type: 'Keyway', variant: 'default', occurrences });
const KEYWAY = keywayFeature('Keyway-default_c1', SHAFT_KEYWAY);
const SLOT = { id: 'Slot-straight_c1', feature_type: 'Slot', variant: 'straight', occurrences: [{ extents_mm: [30, 6, 4], material_removed_mm3: 720, length_mm: 30, width_mm: 6, depth_mm: 4 }] };
const POCKET = { id: 'PocketV2-default_c1', feature_type: 'PocketV2', variant: 'default', occurrences: [{ extents_mm: [60, 40, 0], depth_mm: 12, material_removed_mm3: 28800 }] };
const FACE = { id: 'PlanarFace-default_c1', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ area_mm2: 2000 }] };

const FINISHING: Partial<Record<MaterialClass, MillingFinishingRow>> = { aluminum: ALUMINIUM, mild_steel: MILD_STEEL };
// The operations as a route times them: planned, then timed on its machine.
const sequence = (features: unknown[], matClass: MaterialClass = 'aluminum', finishing: MillingFinishingRow | null | undefined = FINISHING[matClass], machinabilityFactor = 1.0) =>
  timeOperations(buildOperationSequence(features, { matClass, machinabilityFactor, calculators: CALCS, removalRateMm3PerMin: REMOVAL_RATE[matClass] ?? null, finishing: finishing ?? null }), CALCS, TEST_MACHINE);
const named = (ops: OperationLine[], name: string) => ops.filter((o) => o.name === name);
// The slot and the pocket are timed on the workbook (migration 1137), each route on its own machine (TEST_MACHINE above).
const onMachine = (features: unknown[], matClass: MaterialClass) =>
  timeOperations(buildOperationSequence(features, {
    matClass, machinabilityFactor: 1.0, calculators: CALCS, removalRateMm3PerMin: REMOVAL_RATE[matClass] ?? null, finishing: FINISHING[matClass] ?? null, workbook: workbookFixture(),
  }), CALCS, TEST_MACHINE);

describe('the sequencer mills a keyway as Obround Slot Milling', () => {
  it('a Keyway is one Obround Slot Milling operation on its feature, timed by its calculator from the CAD length, width and depth', () => {
    const ops = sequence([KEYWAY]);
    expect(ops.map((o) => o.name)).toEqual(['Obround Slot Milling', 'Deburr']);
    const [op] = named(ops, 'Obround Slot Milling');
    expect(op).toMatchObject({ source: 'feature', cadFeatureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] });
    expect(op!.missing).toBeUndefined();
    expect(op!.timeSec).toBeCloseTo(0.557625, 9);
    expect(op!.calculator).toMatchObject({ id: 'Machining - Obround Slot Milling' });
    expect(op!.trace!.filter((s) => s.kind === 'input').map((s) => [s.fieldName, s.value, s.source])).toEqual([
      ['Keyway Length', 9.971, 'CAD: keyway length'],
      ['Keyway Width', 4, 'CAD: keyway width, the diameter of the cutter'],
      ['Keyway Depth', 2.951, 'CAD: keyway depth'],
      ['Keyways', 1, 'CAD: keyways of this size'],
      ['Teeth', 3, 'tblMillingFinishing: aluminum Teeth'],
      ['Cutting Speed', 183, 'tblMillingFinishing: aluminum CuttingSpeedMPerMin 183 m/min x machinability factor 1'],
      ['Feed per Tooth per Diameter', 0.008, 'tblMillingFinishing: aluminum FeedPerToothPerDiameter'],
      ['Max Spindle Speed', 10000, 'Machine: test spindle_speed_rpm'],
      ['Slotting Depth Ratio', 1, expect.stringMatching(/^The Uddeholm Corrax end milling table pasted on the Machining calculator workbook/)],
    ]);
    const row = { table: 'tblMillingFinishing', row: { MaterialClass: 'aluminum' } };
    expect(op!.calculator!.lookups).toEqual({ 'Teeth': row, 'Cutting Speed': row, 'Feed per Tooth per Diameter': row });
  });

  it('is no longer the removed volume at the bulk removal rate: no Rough Milling of a keyway, and the volume is not an input', () => {
    const ops = sequence([KEYWAY, FACE]);
    expect(named(ops, 'Rough Milling')).toEqual([]);
    expect(named(ops, 'Bulk Milling')).toEqual([]);
    const [op] = named(ops, 'Obround Slot Milling');
    expect(op!.trace!.some((s) => s.fieldName === 'Removed Volume' || s.fieldName === 'Material Removal Rate')).toBe(false);
    // The removal rate does not time it: the same with none on file.
    const noRate = timeOperations(buildOperationSequence([KEYWAY], { matClass: 'aluminum', machinabilityFactor: 1.0, calculators: CALCS, removalRateMm3PerMin: null, finishing: ALUMINIUM }), CALCS, TEST_MACHINE);
    expect(named(noRate, 'Obround Slot Milling')[0]!.timeSec).toBeCloseTo(0.557625, 9);
  });

  it('is cut slower in mild steel, by that material\'s cutter row', () => {
    expect(named(sequence([KEYWAY], 'mild_steel'), 'Obround Slot Milling')[0]!.timeSec).toBeCloseTo(0.6915, 4);
  });

  it('the cutting speed carries the material\'s machinability, as every tool-path operation\'s does', () => {
    // Mild steel at twice the baseline machinability: 152 m/min is 12 096 rpm, held to 10 000; feed 10 000 x 4 x 0.008 x 4 = 1280 mm/min;
    // 1 x 8.922 / 1280 x 60 = 0.4182 s.
    const [op] = named(sequence([KEYWAY], 'mild_steel', MILD_STEEL, 2.0), 'Obround Slot Milling');
    expect(op!.trace!.find((s) => s.fieldName === 'Cutting Speed')).toMatchObject({ value: 152 });
    expect(op!.timeSec).toBeCloseTo(0.4182, 4);
  });

  it('keyways of one size are one operation that counts them; another size is another operation', () => {
    const wider = { material_removed_mm3: 300, depth_mm: 3, length_mm: 20, width_mm: 5 };
    const ops = named(sequence([keywayFeature('Keyway-default_c2', SHAFT_KEYWAY, wider, { ...SHAFT_KEYWAY, face_ids: [40, 41, 42] })]), 'Obround Slot Milling');
    expect(ops.map((o) => [o.count, o.featureIds])).toEqual([[2, ['Keyway-default_c2']], [1, ['Keyway-default_c2']]]);
    expect(ops[0]!.timeSec).toBeCloseTo(2 * 0.557625, 9);
    // 20 x 5 x 3: 10 000 rpm, feed 1200 mm/min, ceil(3 / 5) = 1 pass of 15 + 3 = 18 mm: 1 x 18 / 1200 x 60 = 0.9 s.
    expect(ops[1]!.timeSec).toBeCloseTo(0.9, 9);
  });

  it('a keyway with a CAD measurement missing is a named gap, never an estimate; a measured one beside it is still timed', () => {
    const noDepth = { material_removed_mm3: 100, length_mm: 9.971, width_mm: 4.0, depth_mm: null };
    const noSize = { material_removed_mm3: 100 };
    const ops = named(sequence([keywayFeature('Keyway-default_c3', SHAFT_KEYWAY, noDepth, noSize, { ...noSize })]), 'Obround Slot Milling');
    expect(ops.map((o) => [o.timeSec > 0, o.missing, o.count])).toEqual([
      [true, undefined, 1],
      [false, 'the CAD depth of the keyway', 1],
      [false, 'the CAD length, width and depth of 2 keyways', 2],
    ]);
    for (const o of ops) expect(o).toMatchObject({ cadFeatureType: 'Keyway', featureIds: ['Keyway-default_c3'] });
    // A zero is no measurement either.
    const zeroWidth = named(sequence([keywayFeature('k', { ...SHAFT_KEYWAY, width_mm: 0 })]), 'Obround Slot Milling');
    expect(zeroWidth.map((o) => [o.timeSec, o.missing])).toEqual([[0, 'the CAD width of the keyway']]);
  });

  it('with no cutter row for the material the keyway is a named gap', () => {
    const [op] = named(sequence([KEYWAY], 'aluminum', null), 'Obround Slot Milling');
    expect(op!.timeSec).toBe(0);
    expect(op!.missing).toBe('Obround Slot Milling: Teeth, Cutting Speed, Feed per Tooth per Diameter');
  });

  it('comes after the roughing and before the slot milling, and deburring is still last', () => {
    expect(sequence([KEYWAY, SLOT, POCKET, FACE]).map((o) => o.name)).toEqual([
      'Fine Finish Milling', 'Fine Finish Milling', 'Rough Milling', 'Obround Slot Milling', 'Slot Milling', 'Deburr',
    ]);
  });
});

describe('a Slot and a pocket are milled on the workbook\'s sheets, not by a keyway\'s passes', () => {
  it('a Slot is one Slot Milling operation (the workbook\'s Slot Milling sheet), with no separate roughing of its volume', () => {
    // 30 x 6 x 4 in mild steel: a 6 mm cutter (the slot's width), 4 teeth, 60 + 0.3 x (120 - 60) = 78 m/min and 0.08 + 0.3 x (0.15 - 0.08)
    // = 0.101 mm/tooth (Range Position 0.3): n = 4138.03 rpm; a pass is as deep as the cutter is wide (6 mm, migration 1157), so 1 depth
    // pass, 1 width pass; (30 + 10 + 6) / (0.101 x 4 x 4138.03) = 0.02752 min = 1.65 s -> 2 s. Plunging it would take ceil(30 / (0.75 x 6))
    // = 7 plunges of 14 mm: 0.0586 min, slower, so it is slotted.
    const ops = onMachine([SLOT], 'mild_steel');
    expect(ops.map((o) => o.name)).toEqual(['Slot Milling', 'Deburr']);
    const [slot] = named(ops, 'Slot Milling');
    expect(slot).toMatchObject({ cadFeatureType: 'Slot', featureIds: ['Slot-straight_c1'], timeSec: 2, count: 1 });
    expect(slot!.calculator?.id).toBe('Machining - Slot Milling');
    expect(slot!.trace!.find((st) => st.fieldName === 'Cutter Diameter')!.source).toBe('CAD: slot width 6 mm, narrower than the material\'s end mill');
    expect(named(ops, 'Obround Slot Milling')).toEqual([]);
  });

  it('a short, deep slot is plunged: the workbook\'s Plunge Milling sheet, corrected, when it is the quicker', () => {
    // 8 x 6 x 60 deep: slotting takes ceil(60 / 6) = 10 passes of 8 + 10 + 6 = 24 mm (240 mm, 8.61 s -> 9 s); plunging ceil(8 / 4.5) = 2
    // plunges (0.75 x 6 mm apart) of 70 mm (140 mm), so it is plunged: 140 / (0.101 x 4 x 4138.03) = 0.08374 min = 5.02 s -> 6 s. The two
    // are compared in the whole seconds each calculator states.
    const deep = { ...SLOT, occurrences: [{ ...SLOT.occurrences[0], extents_mm: [8, 6, 0], length_mm: 8, depth_mm: 60, material_removed_mm3: 2880 }] };
    const [slot] = named(onMachine([deep], 'mild_steel'), 'Slot Milling');
    expect(slot!.calculator?.id).toBe('Machining - Plunge Milling');
    expect(slot!.timeSec).toBe(6);
    expect(slot!.trace!.find((st) => st.fieldName === 'Plunges')!.value).toBe(2);
  });

  it('a long, deep slot is slotted a cutter diameter a pass: quicker than plunging its length', () => {
    // 30 x 6 x 30 deep: ceil(30 / 6) = 5 passes of 46 mm (230 mm) against ceil(30 / 4.5) = 7 plunges of 40 mm (280 mm):
    // 230 / (0.101 x 4 x 4138.03) = 0.13758 min = 8.25 s -> 9 s. (Half the cutter a pass, before 1157, made it 10 passes and plunged it.)
    const deep = { ...SLOT, occurrences: [{ ...SLOT.occurrences[0], extents_mm: [30, 6, 0], depth_mm: 30, material_removed_mm3: 5400 }] };
    const [slot] = named(onMachine([deep], 'mild_steel'), 'Slot Milling');
    expect(slot!.calculator?.id).toBe('Machining - Slot Milling');
    expect(slot!.timeSec).toBe(9);
    expect(slot!.trace!.find((st) => st.fieldName === 'Depth Passes')!.value).toBe(5);
  });

  it('a pocket is roughed by the workbook\'s End Milling sheet, then its floor and walls finished', () => {
    const ops = onMachine([POCKET], 'mild_steel');
    expect(ops.map((o) => o.name)).toEqual(['Fine Finish Milling', 'Rough Milling', 'Deburr']);
    // 60 x 40 x 12 with the 10 mm end mill: width passes ceil((40 - 5) / 8) = 5, depth passes ceil(12 / 2) = 6; 78 m/min, 0.101 mm/tooth
    // (Range Position 0.3): n = 2482.82 rpm; (60 + 10 + 5) / (0.101 x 4 x 2482.82) x 30 = 2.24314 min = 134.59 s -> 135 s.
    expect(named(ops, 'Rough Milling')[0]!.timeSec).toBe(135);
    // Finishing: floor 60 x 40 / (10 x 0.95) + walls 2 x (60 + 40) x 12 / (10 x 1.5) + lead 2 x 10 = 252.63 + 160 + 20 = 432.63 mm at
    // 774.13 mm/min.
    expect(named(ops, 'Fine Finish Milling')[0]!.timeSec).toBeCloseTo((2400 / 9.5 + 160 + 20) / ((76000 / (Math.PI * 10)) * 4 * 0.008 * 10) * 60, 9);
    expect(named(ops, 'Obround Slot Milling')).toEqual([]);
  });

  it('a keyway on the part changes neither: their operations are what they are without it', () => {
    const without = onMachine([SLOT, POCKET, FACE], 'mild_steel');
    const withKeyway = onMachine([SLOT, POCKET, FACE, KEYWAY], 'mild_steel');
    expect(withKeyway.filter((o) => o.name !== 'Obround Slot Milling')).toEqual(without);
  });
});

describe('a fine surface finish on the drawing (Ra under 1.6) and a keyway', () => {
  it('slows the keyway\'s passes when they are the part\'s only milling of a finished surface, as it slowed the keyway\'s roughing: no flat finish pass is added', () => {
    const ops = injectDrawingIntelligence(sequence([KEYWAY]), { surfaceFinishRa: { value: 0.8 } });
    expect(ops.map((o) => o.name)).toEqual(['Obround Slot Milling', 'Deburr']);
    expect(named(ops, 'Obround Slot Milling')[0]!.timeSec).toBeCloseTo(0.557625 * 1.3, 9);
  });

  it('slows the finishing pass first where the part has one, the keyway then as it is', () => {
    const ops = injectDrawingIntelligence(sequence([KEYWAY, FACE]), { surfaceFinishRa: { value: 0.8 } });
    expect(named(ops, 'Obround Slot Milling')[0]!.timeSec).toBeCloseTo(0.557625, 9);
    expect(named(ops, 'Fine Finish Milling')[0]!.timeSec).toBeCloseTo(named(sequence([FACE]), 'Fine Finish Milling')[0]!.timeSec * 1.3, 9);
  });
});

// ── The mill line ────────────────────────────────────────────────────────────

const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);

/** A milled aluminium part on a 3-axis mill at 900 per hour, costed on these sequenced operations. */
function milled(featureOps: OperationLine[]) {
  const input: MachiningCostInput = {
    volume: 40_000, surfaceArea: 9000, maxLength: 60, maxWidth: 40, maxHeight: 20,
    holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 100, family: 'milled', finishedWeightKg: 0.108,
    // The mill's rapid traverse rate (migration 1141) and the machining variables' rapid transfer factor (migration 639): its moves.
    mhrRate: rate(900, { machineClass: '3_axis_mill', setupTimeHr: 0.5, rapidTraverseMmPerMin: 30000, maxSpindleRpm: 10000 }), rapidTransferDistanceFactor: 0.5,
    tappingRate: rate(900, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null,
    machiningCalculators: CALCS,
    millingRemovalRateMm3PerMin: 60000,
    featureOps,
  };
  return computeMillingCostSummary(input, '3_axis_mill' as MachineClassId);
}
const millLine = (featureOps: OperationLine[]) => milled(featureOps).processLines.find((l) => l.process === '3 Axis Mill')!;

describe('on a mill the keyway counts toward the line\'s Slot and Groove Milling Time', () => {
  // The housing's two keyways of one size, and a face to finish: 2 x 0.557625 = 1.11525 s of keyway milling.
  const pair = keywayFeature('Keyway-default_c1', SHAFT_KEYWAY, { ...SHAFT_KEYWAY, face_ids: [40, 41, 42, 43, 44] });
  const ops = sequence([pair, FACE]);
  const line = millLine(ops);
  const input = (field: string) => line.calculationTrace!.find((s) => s.kind === 'input' && s.fieldName === field)!;

  it('the keyways\' time is the group\'s input, named and tied to the keyway feature', () => {
    expect(line.calculatorId).toBe('Machining - Milling');
    expect(input('Slot and Groove Milling Time')).toMatchObject({
      value: 1.1153, source: 'CAD features: Obround Slot Milling (operation sequence)',
      ref: { kind: 'features', label: 'Slot and Groove Milling Time', features: [{ featureId: 'Keyway-default_c1' }] },
    });
    // Not roughing, and not left to the catch-all group.
    expect(input('Rough Milling Time')).toMatchObject({ value: 0, source: 'CAD features: none of this group on the part' });
    expect(input('Other Operations Time')).toMatchObject({ value: 0, source: 'CAD features: none of this group on the part' });
  });

  it('the line is its groups plus the moves: the keyways add their time, one tool change and a rapid move to each', () => {
    const without = millLine(sequence([FACE]));
    // One cutter (the 4 mm keyway end mill) at 4.2 s, and two rapid moves of 0.5 x 60 mm at 30 000 mm/min (0.06 s each).
    expect(line.cycleTimeMin * 60 - without.cycleTimeMin * 60).toBeCloseTo(1.11525 + 4.2 + 0.12, 1);
    const cutting = line.calculationTrace!.find((s) => s.fieldName === 'Cutting Time')!.value as number;
    const cuttingWithout = without.calculationTrace!.find((s) => s.fieldName === 'Cutting Time')!.value as number;
    expect(cutting - cuttingWithout).toBeCloseTo(1.11525, 3);
  });

  it('the keyway\'s own calculation is on the line, under its operation', () => {
    const step = (field: string) => line.calculationTrace!.find((s) => s.fieldName === `Obround Slot Milling · ${field}`);
    expect(step('Keyway Width')).toMatchObject({ value: 4 });
    expect(step('Keyways')).toMatchObject({ value: 2 });
    expect(step('Passes')).toMatchObject({ value: 1 });
    expect(step('Cycle Time')).toMatchObject({ value: 1.1153 });
    expect(line.physicsGap).toBeUndefined();
  });

  it('a keyway that could not be timed makes the mill line a named gap: the route is not fully costed', () => {
    const gap = millLine(sequence([keywayFeature('Keyway-default_c1', { ...SHAFT_KEYWAY, depth_mm: null }), FACE]));
    expect((gap.physicsGap as { reason?: string } | undefined)?.reason).toContain('the CAD depth of the keyway');
  });
});
