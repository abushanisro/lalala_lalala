// The cylinders a lathe turns from a bar (turned-diameters.ts): each turned diameter the analysis recognised (a Ring) that is smaller
// than the bar, on its own diameter and length; a Ring at the bar's diameter is left as supplied; a part with no Rings is one cylinder.
import { cylindersToTurn, turnedRings, type TurnedPart, type TurnedRing } from '../../../../../../modules/bom-items/costing/machining/process/turned-diameters';

// A stepped shaft as the cad-engine reports it: Ø14 in the middle, a Ø12 step at each end.
const FEATURES = [
  { id: 'od_0', type: 'Ring', variant: 'outer_diameter', params: { diameter_mm: 14, length_mm: 8, position_along_axis_mm: -12 }, face_ids: [9] },
  { id: 'od_1', type: 'Ring', variant: 'outer_diameter', params: { diameter_mm: 12, length_mm: 18, position_along_axis_mm: -22.75 }, face_ids: [17] },
  { id: 'od_2', type: 'Ring', variant: 'outer_diameter', params: { diameter_mm: 12, length_mm: 5, position_along_axis_mm: -5.25 }, face_ids: [24, 25] },
  { id: 'groove_0', type: 'Ring', variant: 'groove', params: { diameter_mm: 10, length_mm: 1 }, face_ids: [30] },
  { id: 'bore_0', type: 'SimpleHole', variant: 'through', params: { diameter_mm: 6, depth_mm: 32 }, face_ids: [40] },
];
const RINGS: TurnedRing[] = [
  { id: 'od_0', diameterMm: 14, lengthMm: 8, faceIds: [9] },
  { id: 'od_1', diameterMm: 12, lengthMm: 18, faceIds: [17] },
  { id: 'od_2', diameterMm: 12, lengthMm: 5, faceIds: [24, 25] },
];
const part = (rings?: TurnedRing[]): TurnedPart => ({
  diameterMm: 14, lengthMm: 32, diameterSource: 'CAD: largest turned outer diameter (Ring feature)', lengthSource: 'CAD: bounding-box extent along the turning axis', rings,
});

describe('turnedRings: the turned outer diameters of an analysis', () => {
  it('reads every outer-diameter Ring with its own diameter, length and faces, in the analysis\'s order', () => {
    expect(turnedRings(FEATURES)).toEqual(RINGS);
  });

  it('is empty for an analysis without machining features, and skips a Ring with no diameter', () => {
    expect(turnedRings(undefined)).toEqual([]);
    expect(turnedRings(null)).toEqual([]);
    expect(turnedRings([{ id: 'od_0', type: 'Ring', variant: 'outer_diameter', params: {} }])).toEqual([]);
  });

  it('a Ring recorded without a length or faces keeps its diameter (it sizes the bar) with nothing to turn or light', () => {
    expect(turnedRings([{ id: 'od_0', type: 'Ring', variant: 'outer_diameter', params: { diameter_mm: 20 } }]))
      .toEqual([{ id: 'od_0', diameterMm: 20, lengthMm: 0, faceIds: [] }]);
  });
});

describe('cylindersToTurn: what a bar leaves to turn', () => {
  it('a bar larger than every Ring: each Ring is turned on its own diameter and length', () => {
    const cylinders = cylindersToTurn(part(RINGS), 16);
    expect(cylinders.map((c) => [c.label, c.diameterMm, c.lengthMm, c.ring?.id])).toEqual([
      ['Ring Ø14 x 8 mm', 14, 8, 'od_0'],
      ['Ring Ø12 x 18 mm', 12, 18, 'od_1'],
      ['Ring Ø12 x 5 mm', 12, 5, 'od_2'],
    ]);
    expect(cylinders.every((c) => c.diameterSource.includes('Ring feature') && c.lengthSource.includes('Ring feature'))).toBe(true);
  });

  it('a Ring at the bar\'s own diameter has no radial stock: it is left as supplied, the smaller ones are turned', () => {
    expect(cylindersToTurn(part(RINGS), 14).map((c) => c.ring?.id)).toEqual(['od_1', 'od_2']);
    expect(cylindersToTurn(part(RINGS), 12)).toEqual([]);
  });

  it('two Rings of one size are told apart by a number', () => {
    const journals: TurnedRing[] = [
      { id: 'od_0', diameterMm: 12, lengthMm: 10, faceIds: [1] },
      { id: 'od_1', diameterMm: 20, lengthMm: 40, faceIds: [2] },
      { id: 'od_2', diameterMm: 12, lengthMm: 10, faceIds: [3] },
    ];
    expect(cylindersToTurn(part(journals), 22).map((c) => c.label)).toEqual(['Ring Ø12 x 10 mm', 'Ring Ø20 x 40 mm', 'Ring Ø12 x 10 mm (2)']);
  });

  it('a part with no Rings is its one fallback cylinder, with the sources it came with; none when the bar is that diameter', () => {
    for (const rings of [undefined, []]) {
      expect(cylindersToTurn(part(rings), 16)).toEqual([{
        label: 'Turned diameter Ø14 x 32 mm', diameterMm: 14, lengthMm: 32,
        diameterSource: 'CAD: largest turned outer diameter (Ring feature)', lengthSource: 'CAD: bounding-box extent along the turning axis', ring: null,
      }]);
      expect(cylindersToTurn(part(rings), 14)).toEqual([]);
    }
  });

  it('no bar diameter: nothing to turn from', () => {
    expect(cylindersToTurn(part(RINGS), 0)).toEqual([]);
  });
});
