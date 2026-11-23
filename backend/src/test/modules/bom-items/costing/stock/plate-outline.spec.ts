// A part's outline through the plate (plate-outline.ts): read from the analysis's stock measurement as the cad-engine writes it (plt_v1),
// never estimated; and grown by the stock left on it for a plate cutting process.
import { grownOutline, PLATE_OUTLINE_MISSING, plateOutlineOf } from '../../../../../modules/bom-items/costing/stock/plate-outline';

// STIFFNER 2 as the cad-engine measures it (geo_v82): a 159.5 x 42 mm plate part 8 mm thick, with four holes through it.
const PLATE = {
  version: 'plt_v1', normal: [0, 0, 1], thickness_mm: 8,
  outline: { perimeter_mm: 397.81, area_mm2: 5058.6, rect: { length_mm: 159.5, width_mm: 42, angle_deg: 0 }, openings: { count: 4, perimeter_mm: 37.7, area_mm2: 28.27 } },
};
const stock = (plate: unknown) => ({ extractionVersion: 'stk_v1', lengthMm: 159.5, plate });

describe('plateOutlineOf', () => {
  it('reads the outline of the stored stock measurement', () => {
    expect(plateOutlineOf(stock(PLATE))).toEqual({
      thicknessMm: 8, perimeterMm: 397.81, areaMm2: 5058.6, rect: { lengthMm: 159.5, widthMm: 42 }, openings: { count: 4, perimeterMm: 37.7, areaMm2: 28.27 },
    });
  });

  it('has none for an analysis made before the outline, for a part it could not be measured on, and for another version of the block', () => {
    expect(plateOutlineOf(undefined)).toBeNull();
    expect(plateOutlineOf(null)).toBeNull();
    expect(plateOutlineOf({ extractionVersion: 'stk_v1', lengthMm: 159.5 })).toBeNull();
    expect(plateOutlineOf(stock(null))).toBeNull();
    expect(plateOutlineOf(stock({ ...PLATE, version: 'plt_v2' }))).toBeNull();
  });

  it('has none for a block that lacks a size: nothing is estimated in its place', () => {
    expect(plateOutlineOf(stock({ ...PLATE, thickness_mm: 0 }))).toBeNull();
    expect(plateOutlineOf(stock({ ...PLATE, outline: { ...PLATE.outline, perimeter_mm: null } }))).toBeNull();
    expect(plateOutlineOf(stock({ ...PLATE, outline: { ...PLATE.outline, area_mm2: undefined } }))).toBeNull();
    expect(plateOutlineOf(stock({ ...PLATE, outline: { ...PLATE.outline, rect: { length_mm: 159.5 } } }))).toBeNull();
  });

  it('reads an outline with no openings stated as having none', () => {
    const { openings: _openings, ...outline } = PLATE.outline;
    expect(plateOutlineOf(stock({ ...PLATE, outline }))?.openings).toEqual({ count: 0, perimeterMm: 0, areaMm2: 0 });
  });

  it('says what to do about a missing outline', () => {
    expect(PLATE_OUTLINE_MISSING).toContain('press Refresh analysis to measure the plate outline');
  });
});

describe('grownOutline', () => {
  it('grows a closed outline by a on every side: P + 2πa, A + P·a + πa², the rectangle 2a longer and wider', () => {
    // STIFFNER 2's outline grown by the 2.1 mm stock allowance:
    //   perimeter 397.81 + 2π x 2.1 = 397.81 + 13.1947 = 411.0047 mm
    //   area      5058.6 + 397.81 x 2.1 + π x 2.1² = 5058.6 + 835.401 + 13.8544 = 5907.8554 mm²
    //   rectangle (159.5 + 4.2) x (42 + 4.2) = 163.7 x 46.2 mm
    const grown = grownOutline({ perimeterMm: 397.81, areaMm2: 5058.6, rect: { lengthMm: 159.5, widthMm: 42 } }, 2.1);
    expect(grown.perimeterMm).toBeCloseTo(411.0047, 4);
    expect(grown.areaMm2).toBeCloseTo(5907.8554, 4);
    expect(grown.rect.lengthMm).toBeCloseTo(163.7, 9);
    expect(grown.rect.widthMm).toBeCloseTo(46.2, 9);
  });

  it('is exact for a rectangle and for a circle', () => {
    // A 100 x 50 rectangle grown by 5: its corners round off (four quarter circles of radius 5).
    const rect = grownOutline({ perimeterMm: 300, areaMm2: 5000, rect: { lengthMm: 100, widthMm: 50 } }, 5);
    expect(rect.perimeterMm).toBeCloseTo(300 + 10 * Math.PI, 9);
    expect(rect.areaMm2).toBeCloseTo(5000 + 300 * 5 + 25 * Math.PI, 9);
    // A Ø40 circle grown by 5 is a Ø50 circle: 2π x 25, π x 25².
    const circle = grownOutline({ perimeterMm: 40 * Math.PI, areaMm2: 400 * Math.PI, rect: { lengthMm: 40, widthMm: 40 } }, 5);
    expect(circle.perimeterMm).toBeCloseTo(50 * Math.PI, 9);
    expect(circle.areaMm2).toBeCloseTo(625 * Math.PI, 9);
  });

  it('leaves an outline as it is with no allowance', () => {
    const outline = { perimeterMm: 397.81, areaMm2: 5058.6, rect: { lengthMm: 159.5, widthMm: 42 } };
    expect(grownOutline(outline, 0)).toEqual(outline);
  });
});
