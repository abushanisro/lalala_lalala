import { AutoFillService } from '../../../../modules/bom-items/services/auto-fill.service';

// A PCB analysed from its 3D model carries the board the engine found (cad-engine pcb/feature_extractor.py, "pcb-step-1") into
// feature_graph.summary.pcbModelGeometry, which the PCB cost reads when the part has no board files.

interface Priv {
  extractGeometryFromCADResult: (cad: unknown) => unknown;
  sanitizeGeometry: (geo: unknown) => unknown;
  buildFeatureGraph: (geo: unknown, family: { family: string | null; confidence: number | null }, cad: unknown) => { summary: Record<string, unknown> };
}
const svc = new AutoFillService({} as never, {} as never, {} as never) as unknown as Priv;

// The engine's analysis of the populated 100 x 80 x 1.6 mm board (cad-engine test/test_pcb_step_measurements.py, parts on both sides),
// as /analyze/geometry returned it with family_hint pcb.
const features = {
  extraction_version: 'pcb-step-1',
  board: { thickness_mm: 1.6, length_mm: 100, width_mm: 80, area_mm2: 8000, perimeter_mm: 360, normal: [0, 0, 1] },
  holes: [{ diameter_mm: 0.8, count: 6 }, { diameter_mm: 3.2, count: 4 }], cutouts: [{ perimeter_mm: 48 }], components: { top: 3, bottom: 1 }, unresolved: [],
};
const summaryOf = (family: string, f: Record<string, unknown>) => {
  const cad = { geometry_features: { manufacturing_features: { manufacturing_intelligence: { detected_family: family, features: f } } } };
  const geo = svc.sanitizeGeometry(svc.extractGeometryFromCADResult(cad));
  return svc.buildFeatureGraph(geo, { family, confidence: 1 }, cad).summary;
};

describe('feature_graph.summary.pcbModelGeometry', () => {
  it('carries the board, its holes, cutouts and the parts on each side as the engine measured them', () => {
    expect(summaryOf('pcb', features).pcbModelGeometry).toEqual({
      extractionVersion: 'pcb-step-1',
      board: features.board, holes: features.holes, cutouts: features.cutouts, components: { top: 3, bottom: 1 }, unresolved: [],
    });
  });

  it('says when the model shows no board, and is absent for another family', () => {
    expect(summaryOf('pcb', { extraction_version: 'pcb-step-1', board: null, holes: [], cutouts: [], components: null, unresolved: ['no board found'] }).pcbModelGeometry)
      .toMatchObject({ board: null, unresolved: ['no board found'] });
    expect(summaryOf('milled', features).pcbModelGeometry).toBeUndefined();
  });
});
