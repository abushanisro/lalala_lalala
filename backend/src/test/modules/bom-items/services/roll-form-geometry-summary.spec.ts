import { AutoFillService, rollFormGeometry } from '../../../../modules/bom-items/services/auto-fill.service';

// A sheet-metal part's analysis carries what it is measured for roll forming (cad-engine sheet_metal/features/roll_form.py, "rf_v1") into
// feature_graph.summary.rollFormGeometry, which the Sheet Metal Roll Forming cost reads: top-level keys camelCase, the objects inside as the
// engine writes them (snake_case), as hydroformGeometry does.

interface Priv {
  extractGeometryFromCADResult: (cad: unknown) => unknown;
  sanitizeGeometry: (geo: unknown) => unknown;
  buildFeatureGraph: (geo: unknown, family: { family: string | null; confidence: number | null }, cad: unknown) => { summary: Record<string, unknown> };
}
interface Stored {
  curve: { radius_mm: number; angle_deg: number } | null;
  bends: Array<{ level: number; flange_before_mm: number }>;
  features: Array<Record<string, unknown>>;
}
const svc = new AutoFillService({} as never, {} as never, {} as never) as unknown as Priv;

// The engine's measurement of a 100 x 40 C channel, 1000 long, t 2, inner radii 3 (cad-engine/test/test_roll_form_measurements.py).
const channel = {
  version: 'rf_v1', axis: [0, 0, 1], axis_source: 'bends', length_mm: 1000, constant_section: true, stock_fraction: 0.998,
  section: { height_mm: 40, width_mm: 100, area_mm2: 345.12, perimeter_mm: 349.13, closed: false, stock_form: 'GENERIC_EXTRUSION' },
  strip_width_mm: 172.56, strip_width_neutral_mm: 171.5, strip_width_check: { flats_mm: 160, bend_arcs_mm: 12.566, agrees: true },
  thickness_mm: 2,
  bends: [
    { angle_deg: 90, inner_radius_mm: 3, flange_before_mm: 35, level: 1, face_ids: [1, 9] },
    { angle_deg: 90, inner_radius_mm: 3, flange_before_mm: 90, level: 1, face_ids: [3, 7] },
  ],
  last_flange_mm: 35, curve: null, features: [],
  ends: [
    { end: 'start', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 172.57, face_ids: [12] },
    { end: 'end', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 172.57, face_ids: [13] },
  ],
};
// The same channel swept round 400 mm through 60 deg, a 10 mm hole half way along.
const curved = {
  ...channel, axis: [0, -0.5, 0.866], axis_source: 'curve', length_mm: 429.17, stock_fraction: 0.995,
  curve: { radius_mm: 409.82, angle_deg: 60, axis: [1, 0, 0] },
  features: [{ feature_type: 'SimpleHole', size_mm: 10, perimeter_mm: 31.42, area_mm2: 78.5, depth_mm: null, station_mm: 214.58, face_ids: [14] }],
};

const cadResult = (family: string, features: Record<string, unknown>) => ({
  geometry_features: { manufacturing_features: { manufacturing_intelligence: { detected_family: family, features: { sheet_thickness_mm: 2, ...features } } } },
});
const summaryOf = (family: string, features: Record<string, unknown>) => {
  const cad = cadResult(family, features);
  const geo = svc.sanitizeGeometry(svc.extractGeometryFromCADResult(cad));
  return svc.buildFeatureGraph(geo, { family, confidence: 0.9 }, cad).summary;
};

describe('feature_graph.summary.rollFormGeometry', () => {
  it('carries the channel as measured: camelCase top-level keys, the engine objects unchanged', () => {
    expect(summaryOf('sheet_metal', { roll_form: channel }).rollFormGeometry).toEqual({
      extractionVersion: 'rf_v1',
      axis: [0, 0, 1],
      axisSource: 'bends',
      lengthMm: 1000,
      constantSection: true,
      stockFraction: 0.998,
      section: channel.section,
      stripWidthMm: 172.56,
      stripWidthNeutralMm: 171.5,
      stripWidthCheck: { flats_mm: 160, bend_arcs_mm: 12.566, agrees: true },
      thicknessMm: 2,
      bends: channel.bends,
      lastFlangeMm: 35,
      curve: null,
      features: [],
      ends: channel.ends,
    });
  });

  it('carries a curved profile: its curve, its bends in strip order and the features at their stations', () => {
    const g = summaryOf('sheet_metal', { roll_form: curved }).rollFormGeometry as Stored;
    expect(g.curve).toEqual({ radius_mm: 409.82, angle_deg: 60, axis: [1, 0, 0] });
    expect(g.bends.map((b) => [b.flange_before_mm, b.level])).toEqual([[35, 1], [90, 1]]);
    expect(g.features[0]).toMatchObject({ feature_type: 'SimpleHole', size_mm: 10, station_mm: 214.58 });
  });

  it('is null when the part is not a profile, or the engine did not measure it (an analysis from before rf_v1)', () => {
    expect(summaryOf('sheet_metal', { roll_form: null }).rollFormGeometry).toBeNull();
    expect(summaryOf('sheet_metal', {}).rollFormGeometry).toBeNull();
  });

  it('is only on sheet-metal parts', () => {
    expect('rollFormGeometry' in summaryOf('milled', { roll_form: channel })).toBe(false);
  });

  it('reads nothing that is not a measurement', () => {
    expect(rollFormGeometry(undefined)).toBeNull();
    expect(rollFormGeometry('rf_v1')).toBeNull();
    expect(rollFormGeometry({ strip_width_mm: 172.56 })).toBeNull(); // no version: not the engine's measurement
  });
});
