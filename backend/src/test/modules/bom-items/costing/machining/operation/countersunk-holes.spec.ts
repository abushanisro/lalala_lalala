import { buildOperationSequence } from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { holeAxes, sitsOnHole } from '../../../../../../modules/bom-items/costing/machining/operation/countersunk-holes';

// R_M-0230-033 CARRIAGE MOUNT (local DB, feature_graph_v2): four Ø2.2 M2.5 holes, each with a Ø4.0 x 0.9 countersink at its mouth.
const m25 = (x: number, y: number) => ({ centroid: [x, y, 9.35], tool_axis: [0, 0, -1], depth_mm: 2.116, spec: 'M2.5×0.45', tapped: true });
const cs = (x: number, y: number) => ({ centroid: [x, y, 10.55], depth_mm: 0.9, extents_mm: [4, 3.971, 0.9] });
const XY: Array<[number, number]> = [[7.95, -2.75], [-7.95, -2.75], [7.95, 2.75], [-7.95, 2.75]];
const holes = { feature_type: 'SimpleHole', variant: 'threaded', diameter_mm: 2.2, occurrences: XY.map(([x, y]) => m25(x, y)) };
const countersinks = { feature_type: 'Edge', variant: 'countersink', diameter_mm: 4, occurrences: XY.map(([x, y]) => cs(x, y)) };

describe('a countersink on a recognised hole is that hole\'s mouth', () => {
  it('sits on a hole when its centre is on the hole\'s axis', () => {
    const axes = holeAxes([holes, countersinks]);
    expect(axes).toHaveLength(4);
    for (const o of countersinks.occurrences) expect(sitsOnHole(o, axes)).toBe(true);
    // 0.2 mm off the axis: another hole's.
    expect(sitsOnHole(cs(8.15, -2.75), axes)).toBe(false);
  });

  it('a hole with no stated axis is taken along the direction the two centres differ in most', () => {
    const axes = holeAxes([{ feature_type: 'MultiStepHole', occurrences: [{ centroid: [0, 0, 5] }] }]);
    expect(sitsOnHole({ centroid: [0, 0.05, 9] }, axes)).toBe(true);
    expect(sitsOnHole({ centroid: [0, 1, 9] }, axes)).toBe(false);
  });

  it('is countersunk, never drilled a second time; a countersink with no hole under it is still drilled', () => {
    const ops = buildOperationSequence([holes, countersinks], { matClass: 'aluminum' });
    const of = (name: string) => ops.filter((o) => o.name === name && o.cadFeatureType === 'Edge');
    expect(of('Drilling')).toEqual([]);
    expect(of('Center Drilling')).toEqual([]);
    expect(of('Countersinking').map((o) => o.count)).toEqual([4]);
    // The holes themselves: drilled (tap drill) and tapped once each.
    expect(ops.filter((o) => o.name === 'Drilling' && o.cadFeatureType === 'SimpleHole').map((o) => o.count)).toEqual([4]);

    const lone = buildOperationSequence([countersinks], { matClass: 'aluminum' });
    expect(lone.filter((o) => o.name === 'Drilling' && o.cadFeatureType === 'Edge').map((o) => o.count)).toEqual([4]);
  });
});
