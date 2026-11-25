import { AutoFillService, machiningStock } from '../../../../modules/bom-items/services/auto-fill.service';
import { MACHINING_STOCK_EXTRACTION_VERSION } from '../../../../modules/bom-items/costing/stock/stock-envelope';

// A machined part's analysis carries what it is measured for its raw stock (cad-engine machining/stock_envelope.py, "stk_v1", the "stock" of
// machining_features) into feature_graph.summary.machiningStock, which the Stock Machining cost reads: top-level keys camelCase, the objects
// inside as the engine writes them (snake_case), as rollFormGeometry does.

interface Priv {
  extractGeometryFromCADResult: (cad: unknown) => unknown;
  sanitizeGeometry: (geo: unknown) => unknown;
  buildFeatureGraph: (geo: unknown, family: { family: string | null; confidence: number | null }, cad: unknown) => { summary: Record<string, unknown> };
}
const svc = new AutoFillService({} as never, {} as never, {} as never) as unknown as Priv;

// The engine's measurement of a stepped shaft, Ø12 x 30 with a Ø20 x 10 collar and a Ø6 bore (cad-engine/test/test_stock_envelope.py).
const shaft = {
  version: 'stk_v1', axis: [1, 0, 0], axis_source: 'turned', length_mm: 40,
  round: { od_mm: 20 }, rect: { width_mm: 20, height_mm: 20, angle_deg: 0 }, hex: null, bore: { diameter_mm: 6 },
  end_faces: { min: [3], max: [7] },
  stock_surface: { round: [{ face_id: 5, kind: 'CurvedWall', area_mm2: 628.319 }], rect: [], hex: [] },
};
// An 80 x 50 x 30 block with a pocket in its top (the same test file).
const block = {
  version: 'stk_v1', axis: [1, 0, 0], axis_source: 'box', length_mm: 80,
  round: { od_mm: 58.31 }, rect: { width_mm: 50, height_mm: 30, angle_deg: 0 }, hex: null, bore: null,
  end_faces: { min: [0], max: [1] },
  stock_surface: {
    round: [],
    rect: [
      { face_id: 3, kind: 'PlanarFace', side: 'w+', area_mm2: 2400 }, { face_id: 2, kind: 'PlanarFace', side: 'w-', area_mm2: 2400 },
      { face_id: 5, kind: 'PlanarFace', side: 'h+', area_mm2: 3200 }, { face_id: 4, kind: 'PlanarFace', side: 'h-', area_mm2: 4000 },
    ],
    hex: [],
  },
};

// The engine's "plate" block for R_M-0230-039 STIFFNER 2 (159.5 x 42, 8 through its standoffs, seven through holes), as it measures it.
const stiffenerPlate = {
  version: 'plt_v1', normal: [0, 0, 1], thickness_mm: 8,
  outline: {
    perimeter_mm: 397.81, area_mm2: 5058.565, rect: { length_mm: 159.5, width_mm: 42, angle_deg: 90 },
    openings: { count: 7, perimeter_mm: 61.385, area_mm2: 42.924 },
  },
};

const cadResult = (family: string, machiningFeatures: Record<string, unknown> | undefined) => ({
  geometry_features: { manufacturing_features: { manufacturing_intelligence: { detected_family: family, features: {} } } },
  ...(machiningFeatures ? { machining_features: { family, features: [], ...machiningFeatures } } : {}),
});
const summaryOf = (family: string, machiningFeatures: Record<string, unknown> | undefined) => {
  const cad = cadResult(family, machiningFeatures);
  const geo = svc.sanitizeGeometry(svc.extractGeometryFromCADResult(cad));
  return svc.buildFeatureGraph(geo, { family, confidence: 0.9 }, cad).summary;
};

describe('feature_graph.summary.machiningStock', () => {
  it('is the version the engine measures now', () => {
    expect(shaft.version).toBe(MACHINING_STOCK_EXTRACTION_VERSION);
  });

  it('carries a shaft as measured: camelCase top-level keys, the engine objects unchanged', () => {
    expect(summaryOf('mill_turn', { stock: shaft }).machiningStock).toEqual({
      extractionVersion: 'stk_v1',
      axis: [1, 0, 0],
      axisSource: 'turned',
      lengthMm: 40,
      round: { od_mm: 20 },
      rect: { width_mm: 20, height_mm: 20, angle_deg: 0 },
      hex: null,
      bore: { diameter_mm: 6 },
      endFaces: { min: [3], max: [7] },
      stockSurface: shaft.stock_surface,
      plate: null,
    });
  });

  it('carries a block: its rectangle, and the faces on its four sides as the engine writes them', () => {
    const stored = summaryOf('milled', { stock: block }).machiningStock as { axisSource: string; bore: unknown; stockSurface: typeof block.stock_surface };
    expect(stored.axisSource).toBe('box');
    expect(stored.bore).toBeNull();
    expect(stored.stockSurface.rect.map((f) => [f.side, f.face_id])).toEqual([['w+', 3], ['w-', 2], ['h+', 5], ['h-', 4]]);
  });

  it('carries the plate outline as the engine writes it, under the stock version it was added to', () => {
    const stored = summaryOf('milled', { stock: { ...block, plate: stiffenerPlate } }).machiningStock as { extractionVersion: string; plate: unknown };
    expect(stored.plate).toEqual(stiffenerPlate);
    expect(stored.extractionVersion).toBe(MACHINING_STOCK_EXTRACTION_VERSION);
  });

  it('has a null plate when the stock has none (an analysis made before the block, or one the engine could not measure) or it is no block', () => {
    expect(machiningStock(block)).toMatchObject({ plate: null });                    // measured before the plate block: no key
    expect(machiningStock({ ...block, plate: null })).toMatchObject({ plate: null }); // the engine could not measure it
    for (const malformed of ['plt_v1', 8, [stiffenerPlate], { thickness_mm: 8 }, { ...stiffenerPlate, version: 1 }]) {
      expect(machiningStock({ ...block, plate: malformed })).toMatchObject({ plate: null, lengthMm: 80 });
    }
  });

  it('is null when the engine could not measure the stock, and absent when the engine did not try (an analysis from before stk_v1)', () => {
    const failed = summaryOf('milled', { stock: null });
    expect('machiningStock' in failed).toBe(true);
    expect(failed.machiningStock).toBeNull();
    expect('machiningStock' in summaryOf('milled', {})).toBe(false);
  });

  it('is only on machined parts: no other analysis has machining features to carry it', () => {
    expect('machiningStock' in summaryOf('sheet_metal', undefined)).toBe(false);
  });

  it('reads nothing that is not a measurement', () => {
    expect(machiningStock(undefined)).toBeNull();
    expect(machiningStock('stk_v1')).toBeNull();
    expect(machiningStock({ length_mm: 40 })).toBeNull(); // no version: not the engine's measurement
  });
});
