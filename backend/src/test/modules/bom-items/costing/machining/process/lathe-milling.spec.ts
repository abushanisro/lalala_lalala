// The milling a lathe does with a live tool (lathe-milling.ts): which of the part's sequenced operations it is, and the lathe's lines
// from them. The operations are the real sequencer's on the features as the CAD engine stores them; every expected time is worked out by
// hand from the stored calculators' formulas:
//
//   Obround Slot Milling (a keyway, cut by an end mill of its width in passes between its two end centres):
//     Spindle Speed = min(10 000, Cutting Speed * 1000 / (pi * Keyway Width))                                   [rpm]
//     Feed Rate     = Spindle Speed * Teeth * Feed per Tooth per Diameter * Keyway Width                        [mm/min]
//     Passes        = ceil(Keyway Depth / (0.2 * Keyway Width))
//     Path per Pass = max(Keyway Length - Keyway Width, 0) + Keyway Depth / Passes                              [mm]
//     Cycle Time    = Keyways * Passes * Path per Pass / Feed Rate * 60                                         [s]
//   Rough Milling = (Removed Volume * 0.8 / Removal Rate + Removed Volume * 0.2 / (Removal Rate * 0.4)) * 60    [s]
//   Slot Milling  = Slots * 20                                                                                  [s]
//
// with the fixture's aluminium: a removal rate of 60 000 mm^3/min, and an end mill run at 183 m/min with 3 teeth and a feed per tooth of
// 0.008 of its diameter (the tblMillingFinishing row).
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { liveToolMilledFeatures } from '../../../../../../modules/bom-items/costing/machining/capability/live-tooling';
import { broachWidthRangeMm, splitKeywayOccurrences } from '../../../../../../modules/bom-items/costing/machining/operation/keyway-routing';
import { buildOperationSequence } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { latheMillingLines, latheMillingOps } from '../../../../../../modules/bom-items/costing/machining/process/lathe-milling';
import { realKeywayBroachReference } from '../real-reference-tables';

const CALCS = specAsCalculators();
const REMOVAL_RATE = 60000;
const FINISHING = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
// The shaft's keyway, 9.971 x 4 x 2.951 mm: 183 000 / (pi x 4) = 14 563 rpm, held to 10 000; feed 10 000 x 3 x 0.008 x 4 = 960 mm/min;
// ceil(2.951 / 0.8) = 4 passes of 5.971 + 2.951 / 4 = 6.70875 mm; 4 x 6.70875 / 960 x 60 = 1.6772 s.
const KEYWAY_SEC = 1.6772;
// The wider keyway, 20 x 5 x 3 mm: 11 650 rpm, held to 10 000; feed 10 000 x 3 x 0.008 x 5 = 1200 mm/min; ceil(3 / 1) = 3 passes of
// 15 + 1 = 16 mm; 3 x 16 / 1200 x 60 = 2.4 s.
const KEYWAY_2_SEC = 2.4;

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
// Two radial slots: extents and removed volume, no length or width.
const SLOTS = {
  id: 'Slot-radial_c1', feature_type: 'Slot', variant: 'radial',
  occurrences: [{ extents_mm: [6, 3, 2], material_removed_mm3: 150 }, { extents_mm: [6, 3, 2], material_removed_mm3: 150 }],
};
// What the lathe turns and drills itself.
const TURNED_AND_DRILLED = [
  { id: 'Ring-outer_diameter_c1', feature_type: 'Ring', variant: 'outer_diameter', occurrences: [{ material_removed_mm3: 900 }] },
  { id: 'SimpleHole-cross_c1', feature_type: 'SimpleHole', variant: 'cross', diameter_mm: 2.529, occurrences: [{ depth_mm: 12 }, { depth_mm: 12 }] },
  { id: 'PlanarFace-default_c1', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ area_mm2: 150 }] },
];

type Finishing = typeof FINISHING | null;
const sequence = (features: unknown[], removalRate: number | null = REMOVAL_RATE, finishing: Finishing = FINISHING) =>
  buildOperationSequence(features, 'aluminum', 1.0, 'Aluminum, ANSI 6061', null, null, null, null, CALCS, null, removalRate, finishing);
const milling = (features: unknown[], removalRate: number | null = REMOVAL_RATE, finishing: Finishing = FINISHING) =>
  latheMillingLines(latheMillingOps(sequence(features, removalRate, finishing)));

describe('latheMillingOps: the sequenced operations a lathe mills', () => {
  it('keeps the operations on the keyways and slots, in the sequencer\'s order, and none of what the lathe turns or drills', () => {
    const ops = latheMillingOps(sequence([...TURNED_AND_DRILLED, KEYWAY, SLOTS]));
    expect(ops.map((o) => [o.name, o.cadFeatureType, o.featureIds])).toEqual([
      ['Rough Milling', 'Slot', ['Slot-radial_c1']],
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
    expect(step('Passes')).toMatchObject({ kind: 'calculated', value: 4 });
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

  it('two slots: their volume roughed on the Rough Milling line, each slot finished on the Slot Milling line', () => {
    // Rough: 300 * 0.8 / 60000 = 0.004 min; 300 * 0.2 / 24000 = 0.0025 min; sum 0.0065 min = 0.39 s.  Slot Milling: 2 * 20 = 40 s.
    const lines = milling([SLOTS]);
    expect(lines.map((l) => [l.operation, l.run.calculatorId])).toEqual([['Rough Milling', 'Machining - Rough Milling'], ['Slot Milling', 'Machining - Slot Milling']]);
    expect(lines[0].run.sec).toBeCloseTo(0.39, 6);
    expect(lines[1].run.sec).toBe(40);
    expect(lines[0].rows).toEqual([{ name: 'Rough Milling // Slot ×2', timeSec: expect.closeTo(0.39, 6), featureType: 'Slot', count: 2, featureIds: ['Slot-radial_c1'] }]);
    expect(lines[1].rows).toEqual([{ name: 'Slot Milling // Slot ×2', timeSec: 40, featureType: 'Slot', count: 2, featureIds: ['Slot-radial_c1'] }]);
  });

  it('a keyway and slots: the keyway has its own line, and the slots\' two lines are what they are without it', () => {
    const lines = milling([KEYWAY, SLOTS]);
    expect(lines.map((l) => l.operation)).toEqual(['Rough Milling', 'Obround Slot Milling', 'Slot Milling']);
    const [rough, keyway, slot] = lines;
    expect([rough, slot]).toEqual(milling([SLOTS]));
    expect(keyway).toEqual(milling([KEYWAY])[0]);
    expect(rough.rows.map((r) => [r.name, r.featureIds])).toEqual([['Rough Milling // Slot ×2', ['Slot-radial_c1']]]);
  });

  it('two keyways of different sizes: each is numbered, so their calculations and rows stay apart, then the total', () => {
    const [line, ...rest] = milling([KEYWAY, KEYWAY_2]);
    expect(rest).toEqual([]);
    expect(line.run.sec).toBeCloseTo(KEYWAY_SEC + KEYWAY_2_SEC, 4);
    expect([...new Set(line.run.trace.map((s) => s.group).filter(Boolean))]).toEqual(['Keyway 1', 'Keyway 2']);
    expect(line.run.trace.find((s) => s.fieldName === 'Keyway 1 · Keyway Width')).toMatchObject({ value: 4 });
    expect(line.run.trace.find((s) => s.fieldName === 'Keyway 2 · Keyway Width')).toMatchObject({ value: 5 });
    expect(line.run.trace.at(-1)).toMatchObject({ fieldName: 'Obround Slot Milling cycle time', kind: 'calculated', value: 4.0772, unit: 's' });
    expect(line.rows).toEqual([
      { name: 'Obround Slot Milling // Keyway 1', timeSec: expect.closeTo(KEYWAY_SEC, 4), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] },
      { name: 'Obround Slot Milling // Keyway 2', timeSec: expect.closeTo(KEYWAY_2_SEC, 6), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c2'] },
    ]);
  });

  it('two keyways of one size: one calculation for both, and one row that counts them', () => {
    const pair = { ...KEYWAY, occurrences: [KEYWAY.occurrences[0], { ...KEYWAY.occurrences[0], face_ids: [31, 32, 33, 34, 35] }] };
    const [line, ...rest] = milling([pair]);
    expect(rest).toEqual([]);
    expect(line.run.sec).toBeCloseTo(2 * 1.6771875, 6);
    expect(line.run.trace.find((s) => s.fieldName === 'Keyways')).toMatchObject({ kind: 'input', value: 2 });
    expect(line.rows).toEqual([{ name: 'Obround Slot Milling // Keyway ×2', timeSec: expect.closeTo(2 * 1.6771875, 6), featureType: 'Keyway', count: 2, featureIds: ['Keyway-default_c1'] }]);
  });

  it('an operation the sequencer could not time is a line with no time that names what it lacks, and no row', () => {
    // No milling removal rate on file for the material: Rough Milling cannot be timed. The keyway and Slot Milling need none.
    const [rough, keyway, slot] = milling([KEYWAY, SLOTS], null);
    expect(rough.operation).toBe('Rough Milling');
    expect(rough.run.sec).toBeNull();
    expect(rough.run.missing).toEqual(['Rough Milling: Material Removal Rate']);
    expect(rough.rows).toEqual([]);
    expect(keyway.run.sec).toBeCloseTo(KEYWAY_SEC, 4);
    expect(slot.run.sec).toBe(40);
    expect(slot.run.missing).toEqual([]);
  });

  it('a keyway with no cutter data for the material is a line with no time that names it; the slots\' lines are untouched', () => {
    const [rough, keyway, slot] = milling([KEYWAY, SLOTS], REMOVAL_RATE, null);
    expect(keyway.operation).toBe('Obround Slot Milling');
    expect(keyway.run.sec).toBeNull();
    expect(keyway.run.missing).toEqual(['Obround Slot Milling: Teeth, Cutting Speed, Feed per Tooth per Diameter']);
    expect(keyway.rows).toEqual([]);
    expect(rough.run.sec).toBeCloseTo(0.39, 6);
    expect(slot.run.sec).toBe(40);
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

  it('an operation with nothing to cut is no line: no volume to rough is not missing data', () => {
    const noVolume = { ...SLOTS, occurrences: SLOTS.occurrences.map((o) => ({ ...o, material_removed_mm3: 0 })) };
    expect(milling([noVolume]).map((l) => [l.operation, l.run.sec])).toEqual([['Slot Milling', 40]]);
  });

  it('flats: their volume roughed on the Rough Milling line, one row for the group, beside the slots\' roughing', () => {
    // Two wrench flats, 290.12 mm^3 each (the circular segment each cuts off its Ø16 over 20 mm): 580.24 * 0.8 / 60000 + 580.24 * 0.2 /
    // 24000 = 0.0125719 min = 0.75431 s.
    const FLATS = { id: 'Flat-default_c2', feature_type: 'Flat', variant: 'default', occurrences: [{ material_removed_mm3: 290.12, depth_mm: 2 }, { material_removed_mm3: 290.12, depth_mm: 2 }] };
    const flatSec = (580.24 * 0.8 / 60000 + 580.24 * 0.2 / 24000) * 60;
    const [line, ...rest] = milling([...TURNED_AND_DRILLED, FLATS]);
    expect(rest).toEqual([]);
    expect(line.operation).toBe('Rough Milling');
    expect(line.run.sec).toBeCloseTo(flatSec, 6);
    expect(line.run.calculatorId).toBe('Machining - Rough Milling');
    expect(line.rows).toEqual([{ name: 'Rough Milling // Flat ×2', timeSec: expect.closeTo(flatSec, 6), featureType: 'Flat', count: 2, featureIds: ['Flat-default_c2'] }]);
    // With slots the two features share the line, each its own row; the Slot Milling line is the slots' alone.
    const [rough, slot] = milling([SLOTS, FLATS]);
    expect(rough.run.sec).toBeCloseTo(0.39 + flatSec, 6);
    expect(rough.rows.map((r) => [r.name, r.featureType])).toEqual([['Rough Milling // Slot ×2', 'Slot'], ['Rough Milling // Flat ×2', 'Flat']]);
    expect(slot).toEqual(milling([SLOTS])[1]);
  });

  it('a flat with no removed volume on file is a line with no time that names it', () => {
    const [line] = milling([{ id: 'Flat-default_c1', feature_type: 'Flat', variant: 'default', occurrences: [{ material_removed_mm3: 0 }] }]);
    expect(line.operation).toBe('Rough Milling');
    expect(line.run.sec).toBeNull();
    expect(line.run.missing).toEqual(['the CAD volume the flat removes']);
    expect(line.rows).toEqual([]);
  });

  it('none: a part with no keyway or slot has no milling line', () => {
    expect(milling(TURNED_AND_DRILLED)).toEqual([]);
    expect(latheMillingLines(undefined)).toEqual([]);
    expect(latheMillingLines([])).toEqual([]);
  });
});
