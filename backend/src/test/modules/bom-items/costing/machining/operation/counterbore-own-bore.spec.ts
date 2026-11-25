import { buildOperationSequence } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';

describe('a counterbore over a tapped hole of its own', () => {
  // R_M-0230-030 MOTOR MOUNT after the CAD fix (geo_v88): six Ø4.5 x 2 counterbores over its Ø2.5 M3 holes, each carrying the bore's
  // thread (bore_spec); the M3 holes are threaded holes of their own.
  const m3 = { feature_type: 'SimpleHole', variant: 'threaded', diameter_mm: 2.5, occurrences: Array.from({ length: 6 }, () => ({ depth_mm: 6, spec: 'M3×0.5', tapped: true })) };
  const counterbores = (boreSpec: string | null) => ({
    feature_type: 'MultiStepHole', variant: 'counterbore', diameter_mm: 4.5,
    occurrences: Array.from({ length: 6 }, () => ({ depth_mm: 2, ...(boreSpec ? { bore_spec: boreSpec } : {}) })),
  });

  it('adds only its step: the bore is drilled and tapped once, as its own hole', () => {
    const ops = buildOperationSequence([m3, counterbores('M3×0.5')], { matClass: 'aluminum' });
    const cb = (name: string) => ops.filter((o) => o.name === name && o.cadFeatureType === 'MultiStepHole');
    expect(cb('Drilling')).toEqual([]);
    expect(cb('Center Drilling')).toEqual([]);
    expect(cb('Step Drilling').map((o) => o.count)).toEqual([6]);
    // The M3 holes: drilled (tap drill) and tapped, six each.
    expect(ops.filter((o) => o.name === 'Tapping' && o.cadFeatureType === 'SimpleHole').map((o) => o.count)).toEqual([6]);
  });

  it('a counterbore whose bore is part of it is drilled, as before', () => {
    const ops = buildOperationSequence([counterbores(null)], { matClass: 'aluminum' });
    expect(ops.filter((o) => o.name === 'Drilling' && o.cadFeatureType === 'MultiStepHole').map((o) => o.count)).toEqual([6]);
  });
});
