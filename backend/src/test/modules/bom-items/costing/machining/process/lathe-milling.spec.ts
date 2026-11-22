// The milling a lathe does with a live tool (lathe-milling.ts): which of the part's sequenced operations it is, and the lathe's lines
// from them. The operations are the real sequencer's on the features as the CAD engine stores them; every expected time is worked out by
// hand from the stored calculators' formulas:
//
//   Rough Milling = (Removed Volume * 0.8 / Removal Rate + Removed Volume * 0.2 / (Removal Rate * 0.4)) * 60    [s]
//   Slot Milling  = Slots * 20                                                                                  [s]
//
// with a removal rate of 60 000 mm^3/min (the fixture's aluminium).
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { liveToolMilledFeatures } from '../../../../../../modules/bom-items/costing/machining/capability/live-tooling';
import { broachWidthRangeMm, splitKeywayOccurrences } from '../../../../../../modules/bom-items/costing/machining/operation/keyway-routing';
import { buildOperationSequence } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { latheMillingLines, latheMillingOps } from '../../../../../../modules/bom-items/costing/machining/process/lathe-milling';
import { realKeywayBroachReference } from '../real-reference-tables';

const CALCS = specAsCalculators();
const REMOVAL_RATE = 60000;

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

const sequence = (features: unknown[], removalRate: number | null = REMOVAL_RATE) =>
  buildOperationSequence(features, 'aluminum', 1.0, 'Aluminum, ANSI 6061', null, null, null, null, CALCS, null, removalRate, null);
const milling = (features: unknown[], removalRate: number | null = REMOVAL_RATE) => latheMillingLines(latheMillingOps(sequence(features, removalRate)));

describe('latheMillingOps: the sequenced operations a lathe mills', () => {
  it('keeps the operations on the keyways and slots, in the sequencer\'s order, and none of what the lathe turns or drills', () => {
    const ops = latheMillingOps(sequence([...TURNED_AND_DRILLED, KEYWAY, SLOTS]));
    expect(ops.map((o) => [o.name, o.cadFeatureType, o.featureIds])).toEqual([
      ['Rough Milling', 'Keyway', ['Keyway-default_c1']],
      ['Rough Milling', 'Slot', ['Slot-radial_c1']],
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
    expect(latheMillingOps(sequence(split.filteredFeatures)).map((o) => [o.name, o.featureIds])).toEqual([['Rough Milling', ['Keyway-default_c1']]]);
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
  it('the shaft\'s keyway: one Rough Milling line, timed by the Rough Milling calculator on the volume the keyway removes', () => {
    // 107.91 * 0.8 / 60000 = 0.0014388 min; 107.91 * 0.2 / (60000 * 0.4) = 0.00089925 min; sum 0.00233805 min = 0.1403 s.
    const [line, ...rest] = milling([...TURNED_AND_DRILLED, KEYWAY]);
    expect(rest).toEqual([]);
    expect(line.operation).toBe('Rough Milling');
    expect(line.run.sec).toBeCloseTo(0.1403, 4);
    expect(line.run.missing).toEqual([]);
    expect(line.run.calculatorId).toBe('Machining - Rough Milling');
    // The calculator's own steps, under its own field names: the line can be reopened in its calculator.
    expect(line.run.trace.find((s) => s.fieldName === 'Removed Volume')).toMatchObject({ kind: 'input', value: 107.91 });
    expect(line.run.trace.find((s) => s.fieldName === 'Cycle Time')).toMatchObject({ kind: 'calculated', value: 0.1403 });
    expect(line.run.lookups['Material Removal Rate']).toEqual({ table: 'tblMillingRemovalRate', row: { MaterialClass: 'aluminum' } });
    // The keyway is the line's row: the Process tree lists it under the line and lights its faces.
    expect(line.rows).toEqual([{ name: 'Rough Milling // Keyway', timeSec: expect.closeTo(0.1403, 4), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] }]);
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

  it('a keyway and slots: the Rough Milling line is their sum, each under its own name, then the total', () => {
    // 0.1403 s (keyway) + 0.39 s (slots) = 0.5303 s.
    const [rough, slot] = milling([KEYWAY, SLOTS]);
    expect(rough.run.sec).toBeCloseTo(0.5303, 4);
    expect([...new Set(rough.run.trace.map((s) => s.group).filter(Boolean))]).toEqual(['Keyway', 'Slot']);
    expect(rough.run.trace.find((s) => s.fieldName === 'Keyway · Removed Volume')).toMatchObject({ value: 107.91 });
    expect(rough.run.trace.find((s) => s.fieldName === 'Slot · Removed Volume')).toMatchObject({ value: 300 });
    expect(rough.run.trace.at(-1)).toMatchObject({ fieldName: 'Rough Milling cycle time', kind: 'calculated', value: 0.5303, unit: 's' });
    expect(rough.rows.map((r) => [r.name, r.featureIds])).toEqual([['Rough Milling // Keyway', ['Keyway-default_c1']], ['Rough Milling // Slot ×2', ['Slot-radial_c1']]]);
    expect(slot.run.sec).toBe(40);
  });

  it('two keyways of different sizes: each is numbered, so their calculations and rows stay apart', () => {
    // Second keyway: 300 mm^3 -> 0.39 s (as the slots' volume above).
    const [rough] = milling([KEYWAY, KEYWAY_2]);
    expect(rough.run.sec).toBeCloseTo(0.1403 + 0.39, 4);
    expect([...new Set(rough.run.trace.map((s) => s.group).filter(Boolean))]).toEqual(['Keyway 1', 'Keyway 2']);
    expect(rough.rows).toEqual([
      { name: 'Rough Milling // Keyway 1', timeSec: expect.closeTo(0.1403, 4), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c1'] },
      { name: 'Rough Milling // Keyway 2', timeSec: expect.closeTo(0.39, 6), featureType: 'Keyway', count: 1, featureIds: ['Keyway-default_c2'] },
    ]);
  });

  it('an operation the sequencer could not time is a line with no time that names what it lacks, and no row', () => {
    // No milling removal rate on file for the material: Rough Milling cannot be timed; Slot Milling needs none.
    const [rough, slot] = milling([KEYWAY, SLOTS], null);
    expect(rough.operation).toBe('Rough Milling');
    expect(rough.run.sec).toBeNull();
    expect(rough.run.missing).toEqual(['Rough Milling: Material Removal Rate (Keyway)', 'Rough Milling: Material Removal Rate (Slot)']);
    expect(rough.rows).toEqual([]);
    expect(slot.run.sec).toBe(40);
    expect(slot.run.missing).toEqual([]);
  });

  it('an operation with nothing to cut is no line: no volume to rough is not missing data', () => {
    const emptyKeyway = { ...KEYWAY, occurrences: [{ ...KEYWAY.occurrences[0], material_removed_mm3: 0 }] };
    expect(milling([emptyKeyway])).toEqual([]);
  });

  it('none: a part with no keyway or slot has no milling line', () => {
    expect(milling(TURNED_AND_DRILLED)).toEqual([]);
    expect(latheMillingLines(undefined)).toEqual([]);
    expect(latheMillingLines([])).toEqual([]);
  });
});
