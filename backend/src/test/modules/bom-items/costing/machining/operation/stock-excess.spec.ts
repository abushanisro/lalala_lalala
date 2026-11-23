// The stock a mill removes around a part (stock-excess.ts):
//
//   stock excess = piece volume - part volume - volume the part's features remove
//
// where the volume the features remove is the material_removed_mm3 of every occurrence of every feature. Every expected number below is
// worked out by hand.
import { featureRemovedVolumeMm3, stockExcess } from '../../../../../../modules/bom-items/costing/machining/operation/stock-excess';

const feature = (feature_type: string, variant: string, ...removedMm3: (number | null | undefined)[]) =>
  ({ id: `${feature_type}-${variant}`, feature_type, variant, occurrences: removedMm3.map((material_removed_mm3) => ({ material_removed_mm3 })) });

describe('the volume a part\'s features remove', () => {
  it('is the material_removed_mm3 of every occurrence of every feature', () => {
    // Two pockets 3000 + 1500; four holes of 282.74 (a 6 mm hole 10 mm deep: pi x 3^2 x 10); a keyway 107.91: 4500 + 1130.96 + 107.91.
    const features = [
      feature('PocketV2', 'default', 3000, 1500),
      feature('SimpleHole', 'through', 282.74, 282.74, 282.74, 282.74),
      feature('Keyway', 'default', 107.91),
    ];
    expect(featureRemovedVolumeMm3(features)).toBeCloseTo(5738.87, 6);
  });

  it('counts the features that leave on another machine, and a turned diameter the mill is charged for as Bulk Milling', () => {
    // A deep hole (gun drilled), a slot (wire cut after heat treatment) and a turned diameter (its cylinder, 900): 2000 + 720 + 900.
    expect(featureRemovedVolumeMm3([feature('SimpleHole', 'blind', 2000), feature('Slot', 'straight', 720), feature('Ring', 'outer_diameter', 900)])).toBe(3620);
  });

  it('takes nothing off for a feature that states no volume: a face, an edge, a hole pattern', () => {
    const stateNone = [
      feature('PlanarFace', 'default', 0, 0), feature('CurvedWall', 'default', 0), feature('Edge', 'round', 0), feature('Edge', 'chamfer', 0),
      feature('SimpleHole', 'pcd_pattern', 0),
    ];
    expect(featureRemovedVolumeMm3(stateNone)).toBe(0);
    expect(featureRemovedVolumeMm3([...stateNone, feature('PocketV2', 'default', 250)])).toBe(250);
  });

  it('reads a volume that is absent, null, not a number or negative as none', () => {
    expect(featureRemovedVolumeMm3([feature('PocketV2', 'default', undefined, null, -5, 40), { id: 'no occurrences', feature_type: 'Slot' }, null, 'x'])).toBe(40);
    expect(featureRemovedVolumeMm3([{ feature_type: 'PocketV2', occurrences: [{ material_removed_mm3: 'abc' }, { material_removed_mm3: 12.5 }, {}] }])).toBe(12.5);
  });

  it('is zero for a part with no feature graph', () => {
    expect(featureRemovedVolumeMm3(null)).toBe(0);
    expect(featureRemovedVolumeMm3(undefined)).toBe(0);
    expect(featureRemovedVolumeMm3([])).toBe(0);
  });
});

describe('the stock around a part', () => {
  it('a plain block cut from a larger piece: all of the difference', () => {
    // A 50 x 30 x 15 block (22 500 mm^3) from a 60 x 40 x 20 piece (48 000 mm^3), no feature: 48 000 - 22 500 = 25 500 mm^3.
    expect(stockExcess({ pieceMm3: 60 * 40 * 20, partMm3: 50 * 30 * 15, featureRemovedMm3: 0 })).toEqual({
      pieceMm3: 48000, partMm3: 22500, featureRemovedMm3: 0, excessMm3: 25500, inconsistent: false,
    });
  });

  it('a part with pockets and holes: the difference less what their own operations remove', () => {
    // An 80 x 50 x 25 piece (100 000 mm^3). The part fills a 76 x 46 x 21 box (73 416 mm^3) less two pockets (3000 + 1500) and four 6 mm
    // holes 10 mm deep (4 x 282.74 = 1130.96): 73 416 - 5630.96 = 67 785.04 mm^3. The features remove 5630.96 mm^3.
    // Stock around the part: 100 000 - 67 785.04 - 5630.96 = 26 584 mm^3, which is the piece less the part's box: 100 000 - 73 416.
    const featureRemovedMm3 = featureRemovedVolumeMm3([feature('PocketV2', 'default', 3000, 1500), feature('SimpleHole', 'through', 282.74, 282.74, 282.74, 282.74)]);
    expect(featureRemovedMm3).toBeCloseTo(5630.96, 6);
    const excess = stockExcess({ pieceMm3: 100000, partMm3: 67785.04, featureRemovedMm3 });
    expect(excess.excessMm3).toBeCloseTo(26584, 6);
    expect(excess.excessMm3).toBeCloseTo(100000 - 76 * 46 * 21, 6);
    expect(excess.inconsistent).toBe(false);
  });

  it('the real STIFFNER 2 from a 2" x 1/2" bar: 105 612.69 - 15 208.37 - 24 766.46 = 65 637.86 mm^3', () => {
    // The piece is 50.8 x 12.7 x 163.7 mm = 105 612.692 mm^3; the part 15 208.37 mm^3; its features remove 24 432.94 (the pocket) +
    // 120.84 + 43.04 (the holes) + 169.64 (the countersinks) = 24 766.46 mm^3.
    const featureRemovedMm3 = featureRemovedVolumeMm3([
      feature('PocketV2', 'default', 24432.94), feature('SimpleHole', 'threaded', 40.28, 40.28, 40.28), feature('SimpleHole', 'blind', 10.76, 10.76, 10.76, 10.76),
      feature('Edge', 'countersink', 42.41, 42.41, 42.41, 42.41), feature('PlanarFace', 'default', 0),
    ]);
    expect(featureRemovedMm3).toBeCloseTo(24766.46, 6);
    expect(stockExcess({ pieceMm3: 50.8 * 12.7 * 163.7, partMm3: 15208.37, featureRemovedMm3 }).excessMm3).toBeCloseTo(65637.86, 2);
  });

  it('features that account for everything leave nothing to mill in bulk, and that is no contradiction', () => {
    // A 40 x 40 x 10 piece (16 000 mm^3), a part of 10 000 mm^3 whose pockets remove the other 6000 mm^3.
    expect(stockExcess({ pieceMm3: 16000, partMm3: 10000, featureRemovedMm3: 6000 })).toMatchObject({ excessMm3: 0, inconsistent: false });
  });

  it('a difference within the rounding of the stated volumes (under 1 mm^3) is neither stock nor a contradiction', () => {
    expect(stockExcess({ pieceMm3: 16000, partMm3: 10000, featureRemovedMm3: 5999.4 })).toMatchObject({ excessMm3: 0, inconsistent: false });
    expect(stockExcess({ pieceMm3: 16000, partMm3: 10000, featureRemovedMm3: 6000.6 })).toMatchObject({ excessMm3: 0, inconsistent: false });
    // Just over a cubic millimetre is stock: 16 000 - 10 000 - 5998.5 = 1.5 mm^3.
    expect(stockExcess({ pieceMm3: 16000, partMm3: 10000, featureRemovedMm3: 5998.5 })).toMatchObject({ excessMm3: 1.5, inconsistent: false });
  });

  it('features stated to remove more than the stock holds: nothing to mill in bulk, never a negative volume, and the volumes contradict', () => {
    // 16 000 - 10 000 - 6450 = -450 mm^3.
    expect(stockExcess({ pieceMm3: 16000, partMm3: 10000, featureRemovedMm3: 6450 })).toEqual({
      pieceMm3: 16000, partMm3: 10000, featureRemovedMm3: 6450, excessMm3: 0, inconsistent: true,
    });
    // The shaft's turned analysis costed on a mill, from a 5/8" round bar: 6648.16 - 2646.02 - 5773.92 = -1771.78 mm^3 (its rings state
    // their own cylinders, 3873.84 mm^3).
    expect(stockExcess({ pieceMm3: 6648.16, partMm3: 2646.02, featureRemovedMm3: 5773.92 })).toMatchObject({ excessMm3: 0, inconsistent: true });
  });

  it('a part larger than its piece contradicts it too', () => {
    expect(stockExcess({ pieceMm3: 9000, partMm3: 10000, featureRemovedMm3: 0 })).toMatchObject({ excessMm3: 0, inconsistent: true });
  });
});
