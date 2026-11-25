// A turned part made on a mill: the stock round its turned diameters is milled off, once.
//
// A turned part's analysis lists each turned outer diameter as a Ring (Ring:outer_diameter) and, by the rule it states every
// diameter-and-length feature with, writes the Ring's material_removed_mm3 as its cylinder, pi/4 x D^2 x length. For a hole that cylinder
// is what the drill takes out. For a turned diameter it is the diameter itself: the part's own material. When such a part is costed on a
// mill (its family set to milled, or a mill's route in the comparison), that volume was read as a removal twice over:
//
//   - the sequencer milled it as Bulk Milling "of the feature": the mill was charged for milling away the part's own solid;
//   - it was taken off the stock around the part, so the real stock round the diameters was milled short, or (the real shaft) the
//     features "removed" more than the piece holds, the volumes were reported as inconsistent, and no stock was milled at all.
//
// What is physically removed is the piece less the part: every hole's cylinder by its own drilling, the keyway by its own milling, and
// all the rest, the stock round the diameters included, by the one Bulk Milling of the stock around the part (stock-excess.ts).
//
// The fixture is the real "Lead Screw side shaft" as its stored analysis stated it on 2026-11-23 (its cross holes and its shoulder
// chamfer then recognised as two cross holes and a countersink), from the 5/8" round bar the stock model chooses in the USA: piece pi/4 x 15.875^2 x 33.588 = 6648.16 mm^3, part 2646.02 mm^3. Bulk Milling of aluminium at
// 60 000 mm^3/min is Removed Volume x 1.3 / 1000 seconds (the stored calculator). Every expected number is worked out by hand.
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildOperationSequence, type MillingFinishingRow, type OperationLine } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { timeOperations } from '../../../../../../modules/bom-items/costing/machining/operation/time-operations';
import { featureRemovedVolumeMm3, isTurnedDiameter, stockExcess, type StockExcess } from '../../../../../../modules/bom-items/costing/machining/operation/stock-excess';
import { workbookFixture } from '../workbook-fixture';

const CALCS = specAsCalculators();
const ALUMINIUM: MillingFinishingRow = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };

const hole = (depth_mm: number, material_removed_mm3: number) => ({ depth_mm, material_removed_mm3, tapped: false, spec: null });
const SHAFT = [
  { id: 'SimpleHole-cross_d2.5_c2', feature_type: 'SimpleHole', variant: 'cross', diameter_mm: 2.5, occurrences: [hole(4.016, 20.17), hole(3.75, 18.84)] },
  { id: 'SimpleHole-through_d7.0_c1', feature_type: 'SimpleHole', variant: 'through', diameter_mm: 7, occurrences: [hole(31.555, 1214.38)] },
  { id: 'Ring-outer_diameter_d14.0_c1', feature_type: 'Ring', variant: 'outer_diameter', diameter_mm: 14, occurrences: [hole(8.145, 1253.83)] },
  { id: 'Ring-outer_diameter_d12.0_c2', feature_type: 'Ring', variant: 'outer_diameter', diameter_mm: 12, occurrences: [hole(18.329, 2072.96), hole(4.837, 547.05)] },
  { id: 'Edge-chamfer_d7.5_c2', feature_type: 'Edge', variant: 'chamfer', diameter_mm: 7.5, occurrences: [hole(0, 0), hole(0, 0)] },
  { id: 'Edge-countersink_d14.0_c1', feature_type: 'Edge', variant: 'countersink', diameter_mm: 14, occurrences: [hole(3.5, 538.78)] },
  { id: 'Edge-chamfer_d12.0_c2', feature_type: 'Edge', variant: 'chamfer', diameter_mm: 12, occurrences: [hole(0, 0), hole(0, 0)] },
  { id: 'Edge-chamfer_d14.0_c1', feature_type: 'Edge', variant: 'chamfer', diameter_mm: 14, occurrences: [hole(0, 0)] },
  {
    id: 'Keyway-default_c1', feature_type: 'Keyway', variant: 'default',
    occurrences: [{ depth_mm: 2.951, width_mm: 4, length_mm: 9.971, width_confined: true, walled_fraction: 1, material_removed_mm3: 107.91 }],
  },
];
const RINGS = SHAFT.filter(isTurnedDiameter);
const PIECE_MM3 = 6648.16;
const PART_MM3 = 2646.02;

// Planned, then timed on a 10 000 rpm test mill as a route times them (every cutting calculator caps its spindle at the machine's own).
const sequence = (stockAround: StockExcess | null) => timeOperations(
  buildOperationSequence(SHAFT, { matClass: 'aluminum', machinabilityFactor: 1.0, materialGrade: 'Aluminum, ANSI 6061', workbook: workbookFixture(), calculators: CALCS, removalRateMm3PerMin: 60000, finishing: ALUMINIUM, stockAround }),
  CALCS, { 'Max Spindle Speed': { value: 10000, source: 'Machine: test spindle_speed_rpm' } });
const named = (ops: OperationLine[], name: string) => ops.filter((o) => o.name === name);
const statedMm3 = (features: readonly { occurrences: readonly { material_removed_mm3: number }[] }[]) =>
  features.reduce((sum, f) => sum + f.occurrences.reduce((s, o) => s + o.material_removed_mm3, 0), 0);

describe('what a turned diameter states is its own cylinder', () => {
  it('pi/4 x D^2 x length of each diameter, more in all than the part itself holds (the shaft is bored)', () => {
    // Ø14 x 8.145: 153.938 x 8.145 = 1253.83. Ø12 x 18.329: 113.097 x 18.329 = 2072.96. Ø12 x 4.837: 113.097 x 4.837 = 547.05.
    expect(RINGS.map((r) => r.id)).toEqual(['Ring-outer_diameter_d14.0_c1', 'Ring-outer_diameter_d12.0_c2']);
    expect(RINGS.flatMap((r) => r.occurrences.map((o) => Math.round((Math.PI / 4) * r.diameter_mm! ** 2 * o.depth_mm * 100) / 100))).toEqual([1253.83, 2072.96, 547.05]);
    expect(statedMm3(RINGS)).toBeCloseTo(3873.84, 6);
    expect(statedMm3(RINGS)).toBeGreaterThan(PART_MM3);
  });
});

describe('the shaft on a mill', () => {
  // What the features with an operation of their own remove: the cross holes 20.17 + 18.84, the bore 1214.38, the countersink 538.78,
  // the keyway 107.91 = 1900.08 mm^3. The diameters' 3873.84 mm^3 is not among them.
  const removed = featureRemovedVolumeMm3(SHAFT);
  const around = stockExcess({ pieceMm3: PIECE_MM3, partMm3: PART_MM3, featureRemovedMm3: removed });
  const ops = sequence(around);

  it('its features remove 1900.08 mm^3, and the stock around it is 6648.16 - 2646.02 - 1900.08 = 2102.06 mm^3', () => {
    expect(removed).toBeCloseTo(1900.08, 6);
    expect(around.excessMm3).toBeCloseTo(2102.06, 6);
    expect(around.inconsistent).toBe(false);
  });

  it('that stock is milled by one Bulk Milling: 2102.06 x 1.3 / 1000 = 2.7327 s', () => {
    const bulk = named(ops, 'Bulk Milling');
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ source: 'fixed' });
    expect(bulk[0]!.timeSec).toBeCloseTo(2.7327, 4);
    expect(bulk[0]!.trace!.find((s) => s.fieldName === 'Removed Volume')).toMatchObject({
      value: expect.closeTo(2102.06, 6),
      source: 'Stock around the part: the piece 6648.16 mm^3 less the part 2646.02 mm^3 and the 1900.08 mm^3 its features remove',
    });
  });

  it('no operation mills a diameter\'s own cylinder (they were 1253.83 and 2620.01 mm^3 of Bulk Milling, 5.04 s)', () => {
    const ringIds = new Set(RINGS.map((r) => r.id));
    expect(ops.filter((o) => (o.featureIds ?? []).some((id) => ringIds.has(id)))).toEqual([]);
    expect(ops.filter((o) => o.cadFeatureType === 'Ring')).toEqual([]);
  });

  it('nothing is milled twice and nothing is left: the bulk and the features\' own operations remove exactly the piece less the part', () => {
    const others = SHAFT.filter((f) => !isTurnedDiameter(f));
    expect(around.excessMm3 + statedMm3(others)).toBeCloseTo(PIECE_MM3 - PART_MM3, 6);
    // Each of those features still has its own operation: the holes and the countersink drilled, the keyway milled by its passes.
    for (const id of ['SimpleHole-cross_d2.5_c2', 'SimpleHole-through_d7.0_c1', 'Edge-countersink_d14.0_c1', 'Keyway-default_c1']) {
      expect(ops.some((o) => (o.featureIds ?? []).includes(id) && o.timeSec > 0)).toBe(true);
    }
  });

  it('the operations on its other features are what they are without the stock', () => {
    expect(ops.filter((o) => o.name !== 'Bulk Milling')).toEqual(sequence(null));
  });
});

describe('a lathe\'s plan, and a part with no stock chosen', () => {
  it('has no milling of the diameters at all: the lathe turns them, each on its own radial stock', () => {
    const ops = sequence(null);
    expect(named(ops, 'Bulk Milling')).toEqual([]);
    expect(ops.filter((o) => o.cadFeatureType === 'Ring')).toEqual([]);
  });
});
