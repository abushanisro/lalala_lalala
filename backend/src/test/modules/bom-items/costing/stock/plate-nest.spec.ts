// The parts one plate makes (plate-nest.ts gridNest): rectangles in a grid, a gap between two parts and a margin to the plate's edge, the
// better of the two orientations. Each count is worked out by hand in its comment, on the standard 914.4 x 457.2 mm plate.
import { gridNest } from '../../../../../modules/bom-items/costing/stock/plate-nest';

const PLATE = { lengthMm: 914.4, widthMm: 457.2 };

describe('gridNest', () => {
  it('fits n parts and n - 1 gaps along a side, with no margin at the edge', () => {
    // 163.7 x 46.2 mm blanks a 0.889 mm saw kerf apart:
    //   along 914.4: floor((914.4 + 0.889) / (163.7 + 0.889)) = floor(915.289 / 164.589) = 5      (5 x 164.589 = 822.945)
    //   across 457.2: floor((457.2 + 0.889) / (46.2 + 0.889)) = floor(458.089 / 47.089)  = 9      (9 x 47.089 = 423.801)
    //   turned: floor(915.289 / 47.089) = 19, floor(458.089 / 164.589) = 2 -> 38
    expect(gridNest(PLATE, { lengthMm: 163.7, widthMm: 46.2 }, 0.889, 0)).toEqual({ partsPerPlate: 45, along: 5, across: 9, rotated: false });
  });

  it('is the count the sawn blanks of a plate were always nested by', () => {
    // The stock model's plate rule before this helper: floor((L + k) / (l + k)) x floor((W + k) / (w + k)), the better orientation.
    const k = 0.889;
    const count = (l: number, w: number) => Math.floor((PLATE.lengthMm + k + 1e-9) / (l + k)) * Math.floor((PLATE.widthMm + k + 1e-9) / (w + k));
    for (const [l, w] of [[163.7, 46.2], [35.4, 26.4], [300, 200], [914.4, 457.2], [457.2, 914.4], [915, 10], [50, 458]] as const) {
      expect(gridNest(PLATE, { lengthMm: l, widthMm: w }, k, 0).partsPerPlate).toBe(Math.max(count(l, w), count(w, l)));
    }
  });

  it('keeps the margin to the plate\'s edge on both sides', () => {
    // 159.5 x 42 mm outlines, a 10 mm cut between two parts and 10 mm to each edge:
    //   along 914.4: floor((914.4 - 2 x 10 + 10) / (159.5 + 10)) = floor(904.4 / 169.5) = 5       (5 x 169.5 = 847.5)
    //   across 457.2: floor((457.2 - 20 + 10) / (42 + 10))       = floor(447.2 / 52)    = 8       (8 x 52 = 416)
    //   turned: floor(904.4 / 52) = 17, floor(447.2 / 169.5) = 2 -> 34
    expect(gridNest(PLATE, { lengthMm: 159.5, widthMm: 42 }, 10, 10)).toEqual({ partsPerPlate: 40, along: 5, across: 8, rotated: false });
    // On a 430 x 457.2 mm plate, a 437.2 mm wide part takes the width exactly with its two 10 mm margins (447.2 / 447.2 = 1), three along
    // the length (floor(420 / 110) = 3); a 437.3 mm one fits neither way (it is longer than the plate when turned).
    const short = { lengthMm: 430, widthMm: 457.2 };
    expect(gridNest(short, { lengthMm: 100, widthMm: 437.2 }, 10, 10)).toEqual({ partsPerPlate: 3, along: 3, across: 1, rotated: false });
    expect(gridNest(short, { lengthMm: 100, widthMm: 437.3 }, 10, 10).partsPerPlate).toBe(0);
    // With no margin both fit: floor(467.2 / 447.3) = 1 across, floor(440 / 110) = 4 along.
    expect(gridNest(short, { lengthMm: 100, widthMm: 437.3 }, 10, 0).partsPerPlate).toBe(4);
  });

  it('turns the parts when that makes more of them', () => {
    // 163.7 x 46.2 mm blanks 26 mm apart, no margin:
    //   straight: floor(940.4 / 189.7) = 4, floor(483.2 / 72.2) = 6 -> 24
    //   turned:   floor(940.4 / 72.2) = 13 (13 x 72.2 = 938.6), floor(483.2 / 189.7) = 2 -> 26
    expect(gridNest(PLATE, { lengthMm: 163.7, widthMm: 46.2 }, 26, 0)).toEqual({ partsPerPlate: 26, along: 13, across: 2, rotated: true });
  });

  it('makes no part of a rectangle that fits neither way', () => {
    expect(gridNest(PLATE, { lengthMm: 920, widthMm: 100 }, 5, 0).partsPerPlate).toBe(0);
    expect(gridNest(PLATE, { lengthMm: 500, widthMm: 460 }, 5, 0).partsPerPlate).toBe(0);
    // It fits the plate itself, but not with its margins.
    expect(gridNest(PLATE, { lengthMm: 900, widthMm: 450 }, 10, 0).partsPerPlate).toBe(1);
    expect(gridNest(PLATE, { lengthMm: 900, widthMm: 450 }, 10, 10).partsPerPlate).toBe(0);
  });
});
