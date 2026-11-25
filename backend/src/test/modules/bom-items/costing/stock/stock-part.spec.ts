// A machined part as the stock model takes it (stock-part.ts): read from the cad-engine's stock measurement (the analysis summary's
// machiningStock), or off the bounding box of an analysis that has none. The measurements below are the cad-engine's own output for the
// Lead Screw side shaft and R_M-0230-039 STIFFNER 2, as the summary stores them: its own keys camelCase, the objects inside as the engine
// writes them.
import { realStockMachiningReference } from './stock-test-data';
import { withoutAsSuppliedFaces } from '../../../../../modules/bom-items/costing/machining/operation/as-supplied-faces';
import { predatesProcessMeasurement } from '../../../../../modules/bom-items/analysis-status';
import { MACHINING_STOCK_EXTRACTION_VERSION } from '../../../../../modules/bom-items/costing/stock/stock-envelope';
import { asSuppliedFaces, NO_STOCK_FACES, stockPartOf, type StockFaces } from '../../../../../modules/bom-items/costing/stock/stock-part';
import { machiningStock } from '../../../../../modules/bom-items/services/auto-fill.service';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { selectStock, type StockPart, type StockSettings } from '../../../../../modules/bom-items/costing/stock/stock-selection';

const SHAFT = {
  extractionVersion: 'stk_v1', axis: [0, 1, 0], axisSource: 'turned', lengthMm: 32.0, round: { od_mm: 14.0 },
  rect: { width_mm: 14.0, height_mm: 14.0, angle_deg: 158.886 }, hex: null, bore: { diameter_mm: 6.0 },
  endFaces: { min: [5], max: [22] },
  stockSurface: { round: [{ face_id: 9, kind: 'CurvedWall', area_mm2: 334.876 }], rect: [], hex: [] },
  plate: null,
};
const STIFFENER = {
  extractionVersion: 'stk_v1', axis: [1, 0, 0], axisSource: 'box', lengthMm: 159.5, round: { od_mm: 42.107 },
  rect: { width_mm: 42.0, height_mm: 8.0, angle_deg: 0 }, hex: null, bore: null,
  endFaces: { min: [9], max: [15] },
  stockSurface: {
    round: [],
    rect: [
      { face_id: 2, kind: 'PlanarFace', side: 'w+', area_mm2: 1276 }, { face_id: 4, kind: 'PlanarFace', side: 'w-', area_mm2: 1276 },
      { face_id: 1, kind: 'PlanarFace', side: 'h+', area_mm2: 3100 }, { face_id: 7, kind: 'PlanarFace', side: 'h+', area_mm2: 120 },
      { face_id: 3, kind: 'PlanarFace', side: 'h-', area_mm2: 6000 }, { face_id: 8, kind: 'PlanarFace', side: 'h-', area_mm2: 90 },
    ],
    hex: [],
  },
};
const SHAFT_BOX = { length: 32.0018, width: 14.0364, height: 14.0019 };
const STIFFENER_BOX = { length: 159.5, width: 42, height: 8 };

describe('a measured part', () => {
  it('is the measurement: its length along the stock, the circle and the rectangle round it, its bore, whatever the bounding box says', () => {
    const { part, faces, note } = stockPartOf({ machiningStock: SHAFT, family: 'mill_turn', box: SHAFT_BOX, volumeMm3: 2646.02, turned: { diameterMm: 14, lengthMm: 32.0018 } });
    expect(part).toEqual({ source: 'measured', family: 'mill_turn', lengthMm: 32, roundOdMm: 14, widthMm: 14, heightMm: 14, hexAcrossFlatsMm: null, boreMm: 6, volumeMm3: 2646.02 });
    expect(faces.endFaceIds).toEqual([5, 22]);
    expect(faces.surface).toEqual({ round: [{ faceId: 9, kind: 'CurvedWall', areaMm2: 334.876 }], rect: [], hex: [] });
    expect(note).toBeNull();
  });

  it('a prismatic part keeps the circle the cad-engine measured (42.107, tighter than the 42.755 round its 42 x 8 rectangle) and its faces on the rectangle\'s sides', () => {
    const { part, faces } = stockPartOf({ machiningStock: STIFFENER, family: 'milled', box: STIFFENER_BOX, volumeMm3: 15208.37 });
    expect(part).toMatchObject({ source: 'measured', lengthMm: 159.5, roundOdMm: 42.107, widthMm: 42, heightMm: 8, hexAcrossFlatsMm: null, boreMm: null });
    expect(faces.endFaceIds).toEqual([9, 15]);
    expect(faces.surface.rect.map((f) => [f.faceId, f.side])).toEqual([[2, 'w+'], [4, 'w-'], [1, 'h+'], [7, 'h+'], [3, 'h-'], [8, 'h-']]);
  });

  it('reads a key in either spelling, and a hexagon\'s width across flats', () => {
    const snake = {
      extraction_version: MACHINING_STOCK_EXTRACTION_VERSION, length_mm: 40, round: { odMm: 27.713 }, rect: { widthMm: 24, heightMm: 27.713 }, hex: { acrossFlatsMm: 24 }, bore: null,
      end_faces: { min: [1], max: [2] }, stock_surface: { round: [], rect: [], hex: [{ faceId: 3, kind: 'PlanarFace', areaMm2: 554 }, { face_id: 4, kind: 'PlanarFace', area_mm2: 554 }] },
    };
    const { part, faces } = stockPartOf({ machiningStock: snake, family: 'milled', box: { length: 40, width: 27.713, height: 24 }, volumeMm3: 18000 });
    // The rectangle's width is its longer side, whichever way the measurement names them.
    expect(part).toMatchObject({ source: 'measured', lengthMm: 40, roundOdMm: 27.713, widthMm: 27.713, heightMm: 24, hexAcrossFlatsMm: 24 });
    expect(faces.endFaceIds).toEqual([1, 2]);
    expect(faces.surface.hex.map((f) => f.faceId)).toEqual([3, 4]);
  });
});

describe('the measurement as the analysis stores it', () => {
  // The cad-engine's own "stock" result for the Lead Screw side shaft (machining/stock_envelope.py), as auto-fill writes it to the summary.
  const engine = {
    version: 'stk_v1', axis: [0, 1, 0], axis_source: 'turned', length_mm: 32.0, round: { od_mm: 14.0 }, rect: { width_mm: 14.0, height_mm: 14.0, angle_deg: 158.886 },
    hex: null, bore: { diameter_mm: 6.0 }, end_faces: { min: [5], max: [22] },
    stock_surface: { round: [{ face_id: 9, kind: 'CurvedWall', area_mm2: 334.876 }], rect: [], hex: [] },
  };

  it('what auto-fill stores is what the stock model reads, and what the analysis status calls current', () => {
    const stored = machiningStock(engine);
    expect(stored).toEqual(SHAFT);
    expect(stockPartOf({ machiningStock: stored, family: 'mill_turn', box: SHAFT_BOX, volumeMm3: 2646.02 }).part).toMatchObject({ source: 'measured', lengthMm: 32, roundOdMm: 14, boreMm: 6 });
    expect(predatesProcessMeasurement({ machiningStock: stored }, 'Stock Machining', 'mill_turn')).toBe(false);
  });

  it('an analysis the status calls stale is one the stock model reads off the bounding box: no key, or another version', () => {
    for (const summary of [{}, { machiningStock: { ...SHAFT, extractionVersion: 'stk_v0' } }]) {
      expect(predatesProcessMeasurement(summary, 'Stock Machining', 'milled')).toBe(true);
      expect(stockPartOf({ machiningStock: (summary as { machiningStock?: Record<string, unknown> }).machiningStock, family: 'milled', box: SHAFT_BOX, volumeMm3: 2646.02 }).part!.source).toBe('bounding box');
    }
  });
});

describe('a part with no measurement is read off its bounding box', () => {
  it('an analysis made before the measurement: the box\'s longest side is the length, the circle the one round its other two sides', () => {
    const { part, faces, note } = stockPartOf({ machiningStock: undefined, family: 'milled', box: { length: 8, width: 159.5, height: 42 }, volumeMm3: 15208.37 });
    // sqrt(42² + 8²) = sqrt(1828) = 42.7551.
    expect(part).toEqual({ source: 'bounding box', family: 'milled', lengthMm: 159.5, roundOdMm: Math.hypot(42, 8), widthMm: 42, heightMm: 8, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 15208.37 });
    expect(part!.roundOdMm).toBeCloseTo(42.7551, 4);
    expect(faces).toEqual(NO_STOCK_FACES);
    expect(note).toBe('The stock is sized from the part\'s bounding box (its analysis was made before the stock measurement): press Refresh analysis to measure the stock the part is cut from.');
  });

  it('a turned part lies along its turning axis: the bar holds its turned diameter, the box\'s sides across the axis are its rectangle', () => {
    const shaft = stockPartOf({ machiningStock: undefined, family: 'mill_turn', box: SHAFT_BOX, volumeMm3: 2646.02, turned: { diameterMm: 14, lengthMm: 32.0018 } }).part;
    expect(shaft).toMatchObject({ source: 'bounding box', lengthMm: 32.0018, roundOdMm: 14, widthMm: 14.0364, heightMm: 14.0019 });
    // A Ø17.6 x 3 disc is fed 3 mm a part, not 17.6: its axis is the box side nearest its turned length.
    const disc = stockPartOf({ machiningStock: undefined, family: 'turned', box: { length: 17.6, width: 17.6, height: 3 }, volumeMm3: 700, turned: { diameterMm: 17.6, lengthMm: 3 } }).part;
    expect(disc).toMatchObject({ lengthMm: 3, roundOdMm: 17.6, widthMm: 17.6, heightMm: 17.6 });
    // The same shaft priced on a mill (family milled) lies along its longest side, as any prismatic part.
    const milled = stockPartOf({ machiningStock: undefined, family: 'milled', box: SHAFT_BOX, volumeMm3: 2646.02, turned: { diameterMm: 14, lengthMm: 32.0018 } }).part;
    expect(milled).toMatchObject({ lengthMm: 32.0018, widthMm: 14.0364, heightMm: 14.0019 });
    expect(milled!.roundOdMm).toBeCloseTo(Math.hypot(14.0364, 14.0019), 9);
  });

  it('a measurement of another version, one the engine could not make, or one with no size is not read: each says why', () => {
    const other = stockPartOf({ machiningStock: { ...SHAFT, extractionVersion: 'stk_v0' }, family: 'mill_turn', box: SHAFT_BOX, volumeMm3: 2646.02, turned: { diameterMm: 14, lengthMm: 32.0018 } });
    expect(other.part).toMatchObject({ source: 'bounding box', roundOdMm: 14, boreMm: null });
    expect(other.faces).toEqual(NO_STOCK_FACES);
    expect(other.note).toContain('its stock measurement is version stk_v0, not stk_v1');
    expect(stockPartOf({ machiningStock: null, family: 'milled', box: STIFFENER_BOX, volumeMm3: 1 }).note).toContain('the cad-engine could not measure its stock');
    expect(stockPartOf({ machiningStock: { ...SHAFT, lengthMm: 0 }, family: 'milled', box: STIFFENER_BOX, volumeMm3: 1 })).toMatchObject({ part: { source: 'bounding box' }, note: expect.stringContaining('holds no size') });
    expect(stockPartOf({ machiningStock: { ...SHAFT, extractionVersion: undefined }, family: 'milled', box: STIFFENER_BOX, volumeMm3: 1 }).note).toContain('version unknown');
  });

  it('a part with no bounding box has no size to cut stock for', () => {
    expect(stockPartOf({ machiningStock: undefined, family: 'milled', box: { length: 0, width: 0, height: 0 }, volumeMm3: 0 }).part).toBeNull();
  });
});

describe('the faces left as the stock supplies them', () => {
  const STOCK = stockReference(realStockMachiningReference()).reference!;
  const USA: StockSettings = { unitSystem: 'US', cutOff: 'saw', remnantMm: 152.4, allowanceMm: null, snap: null };
  const shaft = stockPartOf({ machiningStock: SHAFT, family: 'mill_turn', box: SHAFT_BOX, volumeMm3: 2646.02 });
  const stiffener = stockPartOf({ machiningStock: STIFFENER, family: 'milled', box: STIFFENER_BOX, volumeMm3: 15208.37 });

  it('none where the stock carries its allowance: the shaft\'s Ø14 on 5/8 in bar is turned, the stiffener\'s sides are milled', () => {
    const bar = selectStock(shaft.part!, STOCK, USA).chosen!;
    expect(bar).toMatchObject({ form: 'round_bar', aMm: 15.875, allowancePerSideMm: 0.79375 });
    expect(asSuppliedFaces(bar, shaft.part!, shaft.faces)).toEqual({ curvedWall: [], planarFace: [] });
    expect(asSuppliedFaces(selectStock(stiffener.part!, STOCK, USA).chosen!, stiffener.part!, stiffener.faces)).toEqual({ curvedWall: [], planarFace: [] });
  });

  it('an allowance of 0 with the stock bought at the part\'s own size: a bar\'s cylinder, a rectangle\'s four sides (bar, plate or billet alike)', () => {
    const exact = { ...USA, allowanceMm: 0, snap: false };
    const bar = selectStock(shaft.part!, STOCK, exact).chosen!;
    expect(bar).toMatchObject({ form: 'round_bar', aMm: 14, allowancePerSideMm: 0 });
    expect(asSuppliedFaces(bar, shaft.part!, shaft.faces)).toEqual({ curvedWall: [9], planarFace: [] });
    for (const form of ['rectangular_bar', 'plate', 'billet'] as const) {
      const stock = selectStock(stiffener.part!, STOCK, exact, form).chosen!;
      expect(stock).toMatchObject({ form, allowancePerSideMm: 0 });
      expect(asSuppliedFaces(stock, stiffener.part!, stiffener.faces)).toEqual({ curvedWall: [], planarFace: [1, 2, 3, 4, 7, 8] });
    }
    // Round bar holds the stiffener too, but none of its faces lies on a cylinder.
    expect(asSuppliedFaces(selectStock(stiffener.part!, STOCK, exact, 'round_bar').chosen!, stiffener.part!, stiffener.faces)).toEqual({ curvedWall: [], planarFace: [] });
  });

  it('an allowance of 0 on stock snapped up to a larger size still leaves stock to machine', () => {
    const snapped = { ...USA, allowanceMm: 0 };
    // Ø14 takes the next inch size, 9/16 in (14.2875): 0.14 mm a side is turned off.
    const bar = selectStock(shaft.part!, STOCK, snapped).chosen!;
    expect(bar).toMatchObject({ aMm: 14.2875, allowancePerSideMm: 0, snapped: true });
    expect(asSuppliedFaces(bar, shaft.part!, shaft.faces)).toEqual({ curvedWall: [], planarFace: [] });
    // The 42 x 8 section takes the next inch sizes, a 1.75 x 3/8 in bar (44.45 x 9.525): neither side is the part's own.
    const rectangular = selectStock(stiffener.part!, STOCK, snapped, 'rectangular_bar').chosen!;
    expect(rectangular).toMatchObject({ aMm: 44.45, bMm: 9.525, allowancePerSideMm: 0 });
    expect(asSuppliedFaces(rectangular, stiffener.part!, stiffener.faces)).toEqual({ curvedWall: [], planarFace: [] });
    // Plate: the 8 mm height takes 3/8 in plate (its two faces are milled); the blank is sawn to the part's own 42 mm width (its w+ and w-
    // sides are left).
    const plate = selectStock(stiffener.part!, STOCK, snapped, 'plate').chosen!;
    expect(plate).toMatchObject({ aMm: 9.525, blank: { widthMm: 42, thicknessMm: 9.525 } });
    expect(asSuppliedFaces(plate, stiffener.part!, stiffener.faces)).toEqual({ curvedWall: [], planarFace: [2, 4] });
  });

  it('hex bar\'s flats are as supplied by the data\'s own rule (hexPercentStockAllowance and hexMinStockWidthAllowance 0, hexSnapStockSize false)', () => {
    const hexStock = { ...SHAFT, hex: { across_flats_mm: 24 }, stockSurface: { round: [], rect: [], hex: [3, 4, 6, 8, 10, 12].map((face_id) => ({ face_id, kind: 'PlanarFace', area_mm2: 554 })) } };
    const part: StockPart = { source: 'measured', family: 'milled', lengthMm: 40, roundOdMm: 48 / Math.sqrt(3), widthMm: 48 / Math.sqrt(3), heightMm: 24, hexAcrossFlatsMm: 24, boreMm: null, volumeMm3: 18000 };
    const faces: StockFaces = stockPartOf({ machiningStock: hexStock, family: 'milled', box: STIFFENER_BOX, volumeMm3: 1 }).faces;
    const hex = selectStock(part, STOCK, USA).chosen!;
    expect(hex).toMatchObject({ form: 'hex_bar', aMm: 24, allowancePerSideMm: 0 });
    expect(asSuppliedFaces(hex, part, faces)).toEqual({ curvedWall: [], planarFace: [3, 4, 6, 8, 10, 12] });
    // A part that is no hexagon, put on hex bar by the Cost Guide, has no face on a flat.
    expect(asSuppliedFaces(selectStock(shaft.part!, STOCK, USA, 'hex_bar').chosen!, shaft.part!, shaft.faces)).toEqual({ curvedWall: [], planarFace: [] });
  });

  it('a part read off its bounding box names no face', () => {
    const boxed = stockPartOf({ machiningStock: undefined, family: 'milled', box: STIFFENER_BOX, volumeMm3: 15208.37 });
    const exact = selectStock(boxed.part!, STOCK, { ...USA, allowanceMm: 0, snap: false }, 'rectangular_bar').chosen!;
    expect(asSuppliedFaces(exact, boxed.part!, boxed.faces)).toEqual({ curvedWall: [], planarFace: [] });
  });
});

describe('the mill does not finish a face left as supplied', () => {
  const features = [
    { id: 'f1', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ face_ids: [1], area_mm2: 3100 }, { face_ids: [5], area_mm2: 400 }, { face_ids: [3], area_mm2: 6000 }] },
    { id: 'f2', feature_type: 'CurvedWall', occurrences: [{ face_ids: [9], area_mm2: 334.876 }] },
    { id: 'f3', feature_type: 'SimpleHole', variant: 'default', occurrences: [{ face_ids: [9], material_removed_mm3: 10 }] },
    { id: 'f4', feature_type: 'PlanarFace', variant: 'default', occurrences: [{ face_ids: [1, 5], area_mm2: 20 }] },
  ];

  it('takes those faces out of the planar faces and curved walls; a face feature left with none goes; every other feature stays', () => {
    const kept = withoutAsSuppliedFaces(features, new Set([1, 3, 9]))!;
    expect(kept.map((f) => f.id)).toEqual(['f1', 'f3', 'f4']);
    // Of f1's three faces only face 5 (400 mm²) is still finished; f4 spans a supplied and a machined face, so it stays whole.
    expect(kept[0].occurrences).toEqual([{ face_ids: [5], area_mm2: 400 }]);
    expect(kept[2]).toBe(features[3]);
    // A hole through a supplied surface is still drilled.
    expect(kept[1]).toBe(features[2]);
  });

  it('changes nothing when no face is as supplied, and has nothing to read with no features', () => {
    expect(withoutAsSuppliedFaces(features, new Set())).toBe(features);
    expect(withoutAsSuppliedFaces(null, new Set([1]))).toBeNull();
  });
});
