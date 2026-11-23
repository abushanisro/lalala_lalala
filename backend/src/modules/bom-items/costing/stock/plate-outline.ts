// A machined part as a piece cut out of plate: its outline seen through the plate, as the cad-engine measures it (machining/stock_envelope.py
// "plate", plt_v1; stored in the analysis summary's machiningStock.plate), and that outline grown by the stock left on it. Pure.
import type { MachiningStockSummary } from './stock-envelope';

/** The plate block's own version (the cad-engine's PLATE_VERSION). An analysis carrying another, or none, has no outline to cut round. */
export const PLATE_OUTLINE_VERSION = 'plt_v1';

/** Said wherever a part's outline is not measured: the two drop-off techniques cut round it, and it is never estimated. */
export const PLATE_OUTLINE_MISSING = 'the part\'s analysis holds no plate outline: press Refresh analysis to measure the plate outline';

/** A closed outline: the length of its boundary, the area inside it, and the smallest rectangle round it (lengthMm >= widthMm). */
export interface OutlineShape {
  perimeterMm: number;
  areaMm2: number;
  rect: { lengthMm: number; widthMm: number };
}

/** The part's outline seen along the direction it is thinnest in. */
export interface PlateOutline extends OutlineShape {
  /** The part's extent along that direction: what the plate must be at least as thick as. */
  thicknessMm: number;
  /** The openings through the outline (windows, through holes). They are features of the part: the mill makes them, no perimeter cut does. */
  openings: { count: number; perimeterMm: number; areaMm2: number };
}

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : null);
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The plate outline of a stored stock measurement; null for an analysis made before it, for a part the cad-engine could not measure it on
 * (plate: null), for another version of the block, and for a block that lacks a size. Nothing is estimated in its place.
 */
export function plateOutlineOf(machiningStock: MachiningStockSummary | null | undefined): PlateOutline | null {
  const plate = bag(bag(machiningStock)?.plate);
  if (!plate || plate.version !== PLATE_OUTLINE_VERSION) return null;
  const outline = bag(plate.outline);
  const rect = bag(outline?.rect);
  const openings = bag(outline?.openings);
  const thicknessMm = positive(plate.thickness_mm);
  const perimeterMm = positive(outline?.perimeter_mm);
  const areaMm2 = positive(outline?.area_mm2);
  const lengthMm = positive(rect?.length_mm);
  const widthMm = positive(rect?.width_mm);
  if (thicknessMm == null || perimeterMm == null || areaMm2 == null || lengthMm == null || widthMm == null) return null;
  return {
    thicknessMm, perimeterMm, areaMm2,
    rect: { lengthMm: Math.max(lengthMm, widthMm), widthMm: Math.min(lengthMm, widthMm) },
    openings: { count: count(openings?.count), perimeterMm: count(openings?.perimeter_mm), areaMm2: count(openings?.area_mm2) },
  };
}

/**
 * An outline grown by `a` on every side: the offset of a closed curve by a distance a (Steiner's formula). The boundary gains 2πa (the
 * corners round off into one full turn of radius a), the area gains a strip of width a along the boundary and that turn's disc, and the
 * rectangle round it gains a on each side:
 *
 *   perimeter = P + 2πa        area = A + P·a + πa²        rectangle = (L + 2a) x (W + 2a)
 *
 * Exact for a convex outline. A concave one (a notch) gains less in both: the offset fills the notch. The formula then overstates the
 * blank, never understates it, so the stock left on the part is never short.
 */
export function grownOutline(outline: OutlineShape, a: number): OutlineShape {
  return {
    perimeterMm: outline.perimeterMm + 2 * Math.PI * a,
    areaMm2: outline.areaMm2 + outline.perimeterMm * a + Math.PI * a ** 2,
    rect: { lengthMm: outline.rect.lengthMm + 2 * a, widthMm: outline.rect.widthMm + 2 * a },
  };
}
