// The milling a lathe does with a live tool (lathe-milling.ts): which of the part's sequenced operations it is, and the lathe's lines
// from them. The operations are the real sequencer's on the features as the CAD engine stores them; every expected time is worked out by
// hand from the stored calculators' formulas:
//
//   Obround Slot Milling (a keyway, cut by an end mill of its width in passes between its two end centres):
//     Spindle Speed = min(10 000, Cutting Speed * 1000 / (pi * Keyway Width))                                   [rpm]
//     Feed Rate     = Spindle Speed * Teeth * Feed per Tooth per Diameter * Keyway Width                        [mm/min]
//     Passes        = ceil(Keyway Depth / (1 * Keyway Width))
//     Path per Pass = max(Keyway Length - Keyway Width, 0) + Keyway Depth / Passes                              [mm]
//     Cycle Time    = Keyways * Passes * Path per Pass / Feed Rate * 60                                         [s]
//   Slot Milling  (the workbook's Slot Milling sheet: a slot cut by an end mill of its width)
//     Spindle Speed = min(Max Spindle Speed, Cutting Speed * 1000 / (pi * Cutter Diameter))                     [rpm]
//     Cycle Time    = Slots * ceil((Slot Length + 10 + D) / (Feed per Tooth * Teeth * n) * Depth Passes * Width Passes * 60)   [s]
//   Rough Milling (the workbook's End Milling sheet: a flat roughed by the end mill)
//     Cycle Time    = Cuts * ceil((Cut Length + 10 + D / 2) / (Feed per Tooth * Teeth * n) * Width Passes * Depth Passes * 60)  [s]
//
// with the fixture's aluminium: the workbook's 300 - 600 m/min and 0.1 - 0.2 mm/tooth (at Range Position 0.3, 390 and 0.13), and the end mill of
// the tblMillingFinishing row (10 mm, 3 teeth; a keyway's run at 183 m/min with a feed per tooth of 0.008 of its diameter), on a live tool
// that turns at most 10 000 rpm.
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { liveToolMilledFeatures } from '../../../../../../modules/bom-items/costing/machining/capability/live-tooling';
import { broachWidthRangeMm, splitKeywayOccurrences } from '../../../../../../modules/bom-items/costing/machining/operation/keyway-routing';
import { buildOperationSequence } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { latheMillingLines, latheMillingOps } from '../../../../../../modules/bom-items/costing/machining/process/lathe-milling';
import { realKeywayBroachReference } from '../real-reference-tables';
import { workbookFixture } from '../workbook-fixture';
import { timeOperations } from '../../../../../../modules/bom-items/costing/machining/operation/time-operations';
import type { MachiningWorkbookInput } from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';

const CALCS = specAsCalculators();
const REMOVAL_RATE = 60000;
const FINISHING = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
// The shaft's keyway, 9.971 x 4 x 2.951 mm: 183 000 / (pi x 4) = 14 563 rpm, held to 10 000; feed 10 000 x 3 x 0.008 x 4 = 960 mm/min;
// ceil(2.951 / 4) = 1 pass of 5.971 + 2.951 = 8.922 mm; 8.922 / 960 x 60 = 0.5576 s.
const KEYWAY_SEC = 0.5576;
// The wider keyway, 20 x 5 x 3 mm: 11 650 rpm, held to 10 000; feed 10 000 x 3 x 0.008 x 5 = 1200 mm/min; ceil(3 / 5) = 1 pass of
// 15 + 3 = 18 mm; 18 / 1200 x 60 = 0.9 s.
const KEYWAY_2_SEC = 0.9;

// Lead Screw side shaft: the closed keyway on its turned diameter, as feature_graph_v2 stores it.
const KEYWAY = {
  id: 'Keyway-default_c1', feature_type: 'Keyway', variant: 'default',
  occurrences: [{
    face_ids: [13, 14, 15, 25, 26], material_removed_mm3: 107.91, depth_mm: 2.951, walled_fraction: 1.0, width_confined: true,
    length_mm: 9.971, width_mm: 4.0, extents_mm: [10.005, 4.0, 2.951],
  }],
};
// A wider keyway elsewhere on a shaft: another group of the same type.
const KEYWAY_2 = { id: 'Keyway-default_c2', feature_type: 'Keyway', variant: 'default', occurrences: [{ material_removed_mm3: 300, depth_mm: 3, length_mm: 20, width_mm: 5 }] };
// Two radial slots, 6 x 3 x 2 mm: their floor's box and measured depth. Each is cut by a 3 mm end mill (the slot's width): 390 m/min holds
// the live tool's 10 000 rpm; 0.13 x 3 x 10 000 = 3900 mm/min; a pass as deep as the cutter is wide (3 mm, migration 1157), so the 2 mm is
// one pass of 6 + 10 + 3 = 19 mm: 19 / 3900 = 0.00487 min = 0.29 s -> 1 s a slot (plunging, 3 plunges of 12 mm, is no quicker), 2 s for the two.
const SLOTS = {
  id: 'Slot-radial_c1', feature_type: 'Slot', variant: 'radial',
  occurrences: [{ extents_mm: [6, 3, 0], depth_mm: 2, material_removed_mm3: 36 }, { extents_mm: [6, 3, 0], depth_mm: 2, material_removed_mm3: 36 }],
};
const SLOTS_SEC = 2;
// Two wrench flats on a Ø16, each 20 mm long, 10.583 mm across and 2 mm deep: the 10 mm end mill, one width pass (ceil((10.583 - 5) / 8)),
// one depth pass; (20 + 10 + 5) / 3900 = 0.00897 min = 0.54 s -> 1 s a flat, 2 s for the two.
const FLAT = { material_removed_mm3: 290.12, length_mm: 20, width_mm: 10.583, depth_mm: 2, diameter_mm: 16 };
const FLATS = { id: 'Flat-default_c2', feature_type: 'Flat', variant: 'default', occurrences: [FLAT, { ...FLAT }] };
const FLATS_SEC = 2;
// What the lathe turns and drills itself.
const TURNED_AND_DRILLED = [
  { id: 'Ring-outer_diameter_c1', feature_type: 'Ring', variant: 'outer_diameter', occurrences: [{ material_removed_mm3: 900 }] },
  { id: 'SimpleHole-cross_c1', feature_type: 'SimpleHole', variant: 'cross', diameter_mm: 2.529, occurrences: [{ depth_mm: 12 }, { depth_mm: 12 }] },
  { id: 'PlanarFace-default_c1', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ area_mm2: 150 }] },
];

type Finishing = typeof FINISHING | null;
const sequence = (features: unknown[], finishing: Finishing = FINISHING, workbook: MachiningWorkbookInput = workbookFixture()) =>
  buildOperationSequence(features, { matClass: 'aluminum', machinabilityFactor: 1.0, materialGrade: 'Aluminum, ANSI 6061', calculators: CALCS, removalRateMm3PerMin: REMOVAL_RATE, finishing, workbook });
// The lathe times what it mills on its live tool's own spindle limit, as the turning engine does (spindleLimitSeed, live tool).
const LIVE_TOOL = { 'Max Spindle Speed': { value: 10000, source: 'Machine: test lathe live_tooling_speed_rpm' } };
const milling = (features: unknown[], finishing: Finishing = FINISHING, workbook: MachiningWorkbookInput = workbookFixture()) =>
  latheMillingLines(timeOperations(latheMillingOps(sequence(features, finishing, workbook)), CALCS, LIVE_TOOL) as ReturnType<typeof latheMillingOps>);

describe('latheMillingOps: the sequenced operations a lathe mills', () => {
  it('keeps the operations on the keyways and slots, in the sequencer\'s order, and none of what the lathe turns or drills', () => {
    const ops = latheMillingOps(sequence([...TURNED_AND_DRILLED, KEYWAY, SLOTS]));
    expect(ops.map((o) => [o.name, o.cadFeatureType, o.featureIds])).toEqual([
      ['Obround Slot Milling', 'Keyway', ['Keyway-default_c1']],
      ['Slot Milling', 'Slot', ['Slot-radial_c1']],
    ]);
  });

  it('is empty for a part with neither', () => {
    expect(latheMillingOps(sequence(TURNED_AND_DRILLED))).toEqual([]);
    expect(latheMillingOps([])).toEqual([]);
  });
});

describe('a broached keyway is not the lathe\'s milling', () => {
  // The keyway of a hub bore, open at both ends: only its two long sides are walled, 2 x 20 / (2 x 20 + 2 x 5) = 0.8 of the floor's
  // outline. A broach is drawn through it (keyway-routing.ts), on a broaching machine: it keeps its own Keyway Broaching line.
  const OPEN_KEYWAY = {
    id: 'Keyway-default_c2', feature_type: 'Keyway', variant: 'default',
    occurrences: [{ material_removed_mm3: 300, depth_mm: 3, length_mm: 20, width_mm: 5, walled_fraction: 0.8 }],
  };
  const split = splitKeywayOccurrences([...TURNED_AND_DRILLED, KEYWAY, OPEN_KEYWAY], broachWidthRangeMm(realKeywayBroachReference()));

  it('the open keyway is the broach\'s; the closed one stays to be milled', () => {
    expect(split.keywayCandidates).toEqual([{ lengthMm: 20, widthMm: 5, depthMm: 3, count: 1 }]);
    expect(latheMillingOps(sequence(split.filteredFeatures)).map((o) => [o.name, o.featureIds])).toEqual([['Obround Slot Milling', ['Keyway-default_c1']]]);
  });

  it('only the milled one needs the lathe\'s live tool', () => {
    expect(liveToolMilledFeatures(split.filteredFeatures)).toEqual([{ type: 'Keyway', count: 1 }]);
    // With every keyway broached the lathe mills nothing, and a lathe with no live tool can make the part.
    const allBroached = splitKeywayOccurrences([...TURNED_AND_DRILLED, OPEN_KEYWAY], broachWidthRangeMm(realKeywayBroachReference()));
    expect(liveToolMilledFeatures(allBroached.filteredFeatures)).toEqual([]);
    expect(latheMillingOps(sequence(allBroached.filteredFeatures))).toEqual([]);
  });
});

describe('latheMillingLines: one lathe line per operation', () => {
  it('the shaft\'s keyway: one Obround Slot Milling line, timed by its calculator on the keyway\'s length, width and depth', () => {
    const [line, ...rest] = milling([...TURNED_AND_DRILLED, KEYWAY]);
    expect(rest).toEqual([]);
    expect(line.operation).toBe('Obround Slot Milling');
    expect(line.run.sec).toBeCloseTo(KEYWAY_SEC, 4);
    expect(line.run.missing).toEqual([]);
    expect(line.run.calculatorId).toBe('Machining - Obround Slot Milling');
    // The calculator's own steps, under its own field names: the line can be reopened in its calculator.
    const step = (field: string) => line.run.trace.find((s) => s.fieldName === field);
    expect(step('Keyway Length')).toMatchObject({ kind: 'input', value: 9.971 });
    expect(step('Keyway Width')).toMatchObject({ kind: 'input', value: 4 });
    expect(step('Keyway Depth')).toMatchObject({ kind: 'input', value: 2.951 });
    expect(step('Passes')).toMatchObject({ kind: 'calculated', value: 1 });
    expect(step('Cycle Time')).toMatchObject({ kind: 'calculated', value: KEYWAY_SEC });
    const row = { table: 'tblMillingFinishing', row: { MaterialClass: 'aluminum' } };
    expect(line.run.lookups).toEqual({ 'Teeth': row, 'Cutting Speed': row, 'Feed per Tooth per Diameter': row });
    // The keyway is the line's row: the Process tree lists it under the line and lights its faces.
    expect(line.rows).toEqual([{ name: 'Obround Slot Milling // Keyway', timeSec: expect.closeTo(KEYWAY_SEC, 4), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] }]);
  });

  it('the time is the keyway\'s passes, not its volume: a keyway with no removed volume on file is still milled', () => {
    const noVolume = { ...KEYWAY, occurrences: [{ ...KEYWAY.occurrences[0], material_removed_mm3: 0 }] };
    const [line, ...rest] = milling([noVolume]);
    expect(rest).toEqual([]);
    expect(line.run.sec).toBeCloseTo(KEYWAY_SEC, 4);
    expect(line.run.trace.some((s) => s.fieldName === 'Removed Volume' || s.fieldName === 'Material Removal Rate')).toBe(false);
  });

  it('two slots: one Slot Milling line, the workbook\'s Slot Milling sheet on each slot\'s length, width and depth, no separate roughing', () => {
    const lines = milling([SLOTS]);
    expect(lines.map((l) => [l.operation, l.run.calculatorId])).toEqual([['Slot Milling', 'Machining - Slot Milling']]);
    expect(lines[0].run.sec).toBe(SLOTS_SEC);
    expect(lines[0].run.trace.find((s) => s.fieldName === 'Depth Passes')).toMatchObject({ kind: 'calculated', value: 1 });
    expect(lines[0].rows).toEqual([{ name: 'Slot Milling // Slot ×2', timeSec: SLOTS_SEC, featureType: 'Slot', count: 2, featureIds: ['Slot-radial_c1'] }]);
  });

  it('a keyway and slots: the keyway has its own line, and the slots\' line is what it is without it', () => {
    const lines = milling([KEYWAY, SLOTS]);
    expect(lines.map((l) => l.operation)).toEqual(['Obround Slot Milling', 'Slot Milling']);
    const [keyway, slot] = lines;
    expect(slot).toEqual(milling([SLOTS])[0]);
    expect(keyway).toEqual(milling([KEYWAY])[0]);
  });

  it('two keyways of different sizes: each is numbered, so their calculations and rows stay apart, then the total', () => {
    const [line, ...rest] = milling([KEYWAY, KEYWAY_2]);
    expect(rest).toEqual([]);
    expect(line.run.sec).toBeCloseTo(KEYWAY_SEC + KEYWAY_2_SEC, 4);
    expect([...new Set(line.run.trace.map((s) => s.group).filter(Boolean))]).toEqual(['Keyway 1', 'Keyway 2']);
    expect(line.run.trace.find((s) => s.fieldName === 'Keyway 1 · Keyway Width')).toMatchObject({ value: 4 });
    expect(line.run.trace.find((s) => s.fieldName === 'Keyway 2 · Keyway Width')).toMatchObject({ value: 5 });
    expect(line.run.trace.at(-1)).toMatchObject({ fieldName: 'Obround Slot Milling cycle time', kind: 'calculated', value: 1.4576, unit: 's' });
    expect(line.rows).toEqual([
      { name: 'Obround Slot Milling // Keyway 1', timeSec: expect.closeTo(KEYWAY_SEC, 4), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] },
      { name: 'Obround Slot Milling // Keyway 2', timeSec: expect.closeTo(KEYWAY_2_SEC, 6), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c2'] },
    ]);
  });

  it('two keyways of one size: one calculation for both, and one row that counts them', () => {
    const pair = { ...KEYWAY, occurrences: [KEYWAY.occurrences[0], { ...KEYWAY.occurrences[0], face_ids: [31, 32, 33, 34, 35] }] };
    const [line, ...rest] = milling([pair]);
    expect(rest).toEqual([]);
    expect(line.run.sec).toBeCloseTo(2 * 0.557625, 6);
    expect(line.run.trace.find((s) => s.fieldName === 'Keyways')).toMatchObject({ kind: 'input', value: 2 });
    expect(line.rows).toEqual([{ name: 'Obround Slot Milling // Keyway ×2', timeSec: expect.closeTo(2 * 0.557625, 6), featureType: 'Keyway', count: 2, featureIds: ['Keyway-default_c1'] }]);
  });

  it('an operation the sequencer could not time is a line with no time that names what it lacks, and no row', () => {
    // The workbook's tables were not read: Slot Milling has no cutting speed or feed. The keyway is timed on its own cutter row.
    const [keyway, slot] = milling([KEYWAY, SLOTS], FINISHING, workbookFixture({ tables: {} }));
    expect(slot.operation).toBe('Slot Milling');
    expect(slot.run.sec).toBeNull();
    expect(slot.run.missing.join('; ')).toContain('tblMillingConditions');
    expect(slot.rows).toEqual([]);
    expect(keyway.run.sec).toBeCloseTo(KEYWAY_SEC, 4);
  });

  it('with no cutter data for the material the keyway and the slots are each a line with no time that names it', () => {
    const [keyway, slot] = milling([KEYWAY, SLOTS], null);
    expect(keyway.operation).toBe('Obround Slot Milling');
    expect(keyway.run.sec).toBeNull();
    expect(keyway.run.missing).toEqual(['Obround Slot Milling: Teeth, Cutting Speed, Feed per Tooth per Diameter']);
    expect(keyway.rows).toEqual([]);
    expect(slot.run.sec).toBeNull();
    expect(slot.run.missing).toEqual(["the material's end mill (tblMillingFinishing has no row for aluminum)"]);
  });

  it('a keyway the CAD gives no depth is a line with no time that names the measurement; one that has its size is still timed', () => {
    const unmeasured = { id: 'Keyway-default_c3', feature_type: 'Keyway', variant: 'default', occurrences: [{ material_removed_mm3: 107.91, length_mm: 9.971, width_mm: 4.0, depth_mm: null }] };
    const [alone] = milling([unmeasured]);
    expect(alone.run.sec).toBeNull();
    expect(alone.run.missing).toEqual(['the CAD depth of the keyway']);
    expect(alone.rows).toEqual([]);
    const [both] = milling([KEYWAY, unmeasured]);
    expect(both.run.sec).toBeCloseTo(KEYWAY_SEC, 4);
    expect(both.run.missing).toEqual(['the CAD depth of the keyway (Keyway 2)']);
    expect(both.rows.map((r) => r.name)).toEqual(['Obround Slot Milling // Keyway 1']);
  });

  it('a slot the CAD gives no depth or volume for is a line with no time that names it, never a free slot', () => {
    const unmeasured = { ...SLOTS, occurrences: SLOTS.occurrences.map((o) => ({ extents_mm: o.extents_mm, material_removed_mm3: 0 })) };
    expect(milling([unmeasured]).map((l) => [l.operation, l.run.sec, l.run.missing])).toEqual([['Slot Milling', null, ['the CAD length, width and depth of every slot']]]);
  });

  it('flats: roughed on the Rough Milling line by the workbook\'s End Milling sheet, one row for the group; the slots keep their own line', () => {
    const [line, ...rest] = milling([...TURNED_AND_DRILLED, FLATS]);
    expect(rest).toEqual([]);
    expect(line.operation).toBe('Rough Milling');
    expect(line.run.sec).toBe(FLATS_SEC);
    expect(line.run.calculatorId).toBe('Machining - Rough Milling');
    expect(line.rows).toEqual([{ name: 'Rough Milling // Flat ×2', timeSec: FLATS_SEC, featureType: 'Flat', count: 2, featureIds: ['Flat-default_c2'] }]);
    // With slots each feature keeps its own line.
    const [rough, slot] = milling([SLOTS, FLATS]);
    expect(rough).toEqual(milling([FLATS])[0]);
    expect(slot).toEqual(milling([SLOTS])[0]);
  });

  it('a flat with no CAD size is a line with no time that names it', () => {
    const [line] = milling([{ id: 'Flat-default_c1', feature_type: 'Flat', variant: 'default', occurrences: [{ material_removed_mm3: 0 }] }]);
    expect(line.operation).toBe('Rough Milling');
    expect(line.run.sec).toBeNull();
    expect(line.run.missing).toEqual(['the CAD length, width and depth of the flat']);
    expect(line.rows).toEqual([]);
  });

  it('none: a part with no keyway or slot has no milling line', () => {
    expect(milling(TURNED_AND_DRILLED)).toEqual([]);
    expect(latheMillingLines(undefined)).toEqual([]);
    expect(latheMillingLines([])).toEqual([]);
  });
});
