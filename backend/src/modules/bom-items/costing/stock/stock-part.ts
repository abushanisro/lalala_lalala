// A machined part as the stock model takes it (stock-selection.ts StockPart), read from its CAD analysis: the stock envelope the cad-engine
// measures (machining/stock_envelope.py, the analysis summary's machiningStock), or, for an analysis made before that measurement, the
// part's bounding box. Also the faces the measurement names: the two ends, where the saw's cuts lie, and the faces lying on the stock's own
// surface, which are left as supplied where the chosen stock carries no allowance. Pure.
import { MACHINING_STOCK_EXTRACTION_VERSION, type MachiningStockSummary } from './stock-envelope';

import type { StockOption, StockPart } from './stock-selection';

/** A face lying on the stock's surface: its id (the analysis's face ordinal), what the reference's catalog calls it, and its area. */
export interface StockSurfaceFace {
  faceId: number;
  kind: 'CurvedWall' | 'PlanarFace';
  areaMm2: number;
  /** A rectangle's side the face lies on: w+ and w- bound its width, h+ and h- its height. */
  side?: 'w+' | 'w-' | 'h+' | 'h-';
}

/** The faces the stock measurement names. Empty for a part read off its bounding box. */
export interface StockFaces {
  /** The planar faces square to the stock's axis at the part's two ends. */
  endFaceIds: number[];
  /** The faces on each envelope: the circle's outer cylinders, the rectangle's four sides, the hexagon's flats. */
  surface: { round: StockSurfaceFace[]; rect: StockSurfaceFace[]; hex: StockSurfaceFace[] };
}

export const NO_STOCK_FACES: StockFaces = { endFaceIds: [], surface: { round: [], rect: [], hex: [] } };

export interface StockPartInput {
  /** The analysis summary's machiningStock: absent for an analysis made before the measurement, null when the part could not be measured. */
  machiningStock: MachiningStockSummary | null | undefined;
  family: StockPart['family'];
  /** The part's bounding box (mm) and volume (mm³). */
  box: { length: number; width: number; height: number };
  volumeMm3: number;
  /** A turned part's largest turned diameter and its length along the turning axis, when the analysis recognised them. */
  turned?: { diameterMm: number; lengthMm: number } | null;
}

export interface StockPartResult {
  /** Null when the part has no size to cut stock for (no measurement and no bounding box). */
  part: StockPart | null;
  faces: StockFaces;
  /** What the quote says of a part read off its bounding box; null for a measured part. */
  note: string | null;
}

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : null);
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** A key in either spelling: the summary's own keys are camelCase, the objects inside are as the cad-engine writes them. */
const read = (o: Bag | null, key: string): unknown => (o == null ? undefined : o[key] ?? o[snake(key)]);
/** The measurement's version, under any of the names it is stored by (as analysis-status.ts reads it to tell a stale analysis). */
const versionOf = (m: Bag | null): unknown => read(m, 'extractionVersion') ?? m?.version;
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);

function surfaceFaces(v: unknown): StockSurfaceFace[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f) => {
    const o = bag(f);
    const faceId = read(o, 'faceId');
    const kind = read(o, 'kind');
    if (!Number.isInteger(faceId) || (kind !== 'CurvedWall' && kind !== 'PlanarFace')) return [];
    const side = read(o, 'side');
    return [{
      faceId: faceId as number, kind, areaMm2: positive(read(o, 'areaMm2')) ?? 0,
      ...(side === 'w+' || side === 'w-' || side === 'h+' || side === 'h-' ? { side } : {}),
    }];
  });
}

/** The measured part, or null when the value is not this version's measurement or lacks a size. */
function measured(input: StockPartInput): { part: StockPart; faces: StockFaces } | null {
  const m = bag(input.machiningStock);
  if (!m || versionOf(m) !== MACHINING_STOCK_EXTRACTION_VERSION) return null;
  const lengthMm = positive(read(m, 'lengthMm'));
  const roundOdMm = positive(read(bag(read(m, 'round')), 'odMm'));
  const rect = bag(read(m, 'rect'));
  const widthMm = positive(read(rect, 'widthMm'));
  const heightMm = positive(read(rect, 'heightMm'));
  if (lengthMm == null || roundOdMm == null || widthMm == null || heightMm == null) return null;
  const ends = bag(read(m, 'endFaces'));
  const surface = bag(read(m, 'stockSurface'));
  return {
    part: {
      source: 'measured', family: input.family, lengthMm, roundOdMm,
      widthMm: Math.max(widthMm, heightMm), heightMm: Math.min(widthMm, heightMm),
      hexAcrossFlatsMm: positive(read(bag(read(m, 'hex')), 'acrossFlatsMm')),
      boreMm: positive(read(bag(read(m, 'bore')), 'diameterMm')),
      volumeMm3: input.volumeMm3,
    },
    faces: {
      endFaceIds: [...ids(read(ends, 'min')), ...ids(read(ends, 'max'))],
      surface: { round: surfaceFaces(read(surface, 'round')), rect: surfaceFaces(read(surface, 'rect')), hex: surfaceFaces(read(surface, 'hex')) },
    },
  };
}

/**
 * The part read off its bounding box. A turned part with a recognised turned diameter lies along its turning axis: the bar holds that
 * diameter, and the box's two sides across the axis are its rectangle. Any other part lies along the box's longest side, and the circle
 * round it is the one round the other two sides (the box says no more of the part's outline). A box shows neither a hexagon nor a bore.
 */
function fromBox(input: StockPartInput): StockPart | null {
  const sides = [input.box.length, input.box.width, input.box.height];
  if (!sides.every((d) => Number.isFinite(d) && d > 0)) return null;
  const base = { source: 'bounding box' as const, family: input.family, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: input.volumeMm3 };
  const turned = input.family !== 'milled' && input.turned && input.turned.diameterMm > 0 && input.turned.lengthMm > 0 ? input.turned : null;
  if (turned) {
    const axis = sides.reduce((best, d, i) => (Math.abs(d - turned.lengthMm) < Math.abs(sides[best] - turned.lengthMm) ? i : best), 0);
    const across = sides.filter((_, i) => i !== axis).sort((a, b) => b - a);
    return { ...base, lengthMm: turned.lengthMm, roundOdMm: turned.diameterMm, widthMm: across[0], heightMm: across[1] };
  }
  const [lengthMm, widthMm, heightMm] = [...sides].sort((a, b) => b - a);
  return { ...base, lengthMm, roundOdMm: Math.hypot(widthMm, heightMm), widthMm, heightMm };
}

/** The part as the stock model takes it: measured when the analysis holds this version's measurement, else read off its bounding box. */
export function stockPartOf(input: StockPartInput): StockPartResult {
  const fromCad = measured(input);
  if (fromCad) return { ...fromCad, note: null };
  const version = versionOf(bag(input.machiningStock));
  const why = input.machiningStock === undefined ? 'its analysis was made before the stock measurement'
    : input.machiningStock === null ? 'the cad-engine could not measure its stock'
      : version !== MACHINING_STOCK_EXTRACTION_VERSION ? `its stock measurement is version ${typeof version === 'string' ? version : 'unknown'}, not ${MACHINING_STOCK_EXTRACTION_VERSION}`
        : 'its stock measurement holds no size';
  return {
    part: fromBox(input), faces: NO_STOCK_FACES,
    note: `The stock is sized from the part's bounding box (${why}): press Refresh analysis to measure the stock the part is cut from.`,
  };
}

/** A side of the part lies on the stock's surface when the stock is no larger than the part there, within this (mm): sizes are held to 0.001 mm. */
const NO_STOCK_LEFT_MM = 1e-6;

/**
 * The faces of the part left as the stock supplies them: those lying on the chosen stock's own surface, where no stock is left on the part.
 * That is where the stock carries no allowance (hex bar's flats by the data's rule, or an allowance the Cost Guide sets to 0) and its size
 * is the part's own: a size snapped up to a larger preferred size leaves stock to machine, whatever the allowance. A round bar or tube's
 * surface is its outer cylinders, a hex bar's its flats; a rectangular or square bar's, a plate's and a billet's are the rectangle's sides,
 * w+ and w- by the stock left on the width, h+ and h- by the stock left on the height (a plate's thickness).
 */
export function asSuppliedFaces(
  option: Pick<StockOption, 'form' | 'aMm' | 'bMm' | 'blank'>, part: Pick<StockPart, 'roundOdMm' | 'widthMm' | 'heightMm' | 'hexAcrossFlatsMm'>, faces: StockFaces,
): { curvedWall: number[]; planarFace: number[] } {
  const none = (stockMm: number | null, partMm: number) => stockMm != null && stockMm - partMm <= NO_STOCK_LEFT_MM;
  const { round, rect, hex } = faces.surface;
  let onStock: StockSurfaceFace[];
  if (option.form === 'round_bar' || option.form === 'round_tube') {
    onStock = none(option.aMm, part.roundOdMm) ? round : [];
  } else if (option.form === 'hex_bar') {
    onStock = part.hexAcrossFlatsMm != null && none(option.aMm, part.hexAcrossFlatsMm) ? hex : [];
  } else {
    // The stock across the rectangle: a rectangular bar's two sides, a square bar's one, a plate's blank width and its thickness.
    const plate = option.form === 'plate' || option.form === 'billet';
    const width = none(plate ? option.blank.widthMm : option.aMm, part.widthMm);
    const height = none(option.form === 'rectangular_bar' ? option.bMm : option.aMm, part.heightMm);
    onStock = rect.filter((f) => (f.side === 'w+' || f.side === 'w-' ? width : f.side === 'h+' || f.side === 'h-' ? height : false));
  }
  const of = (kind: StockSurfaceFace['kind']) => [...new Set(onStock.filter((f) => f.kind === kind).map((f) => f.faceId))].sort((a, b) => a - b);
  return { curvedWall: of('CurvedWall'), planarFace: of('PlanarFace') };
}
