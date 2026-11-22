// What a band saw's cut of raw stock is timed from, by memory/Stock Maching's tables: the cutting rate of the material at the width in the
// cut (bandSawCutting), the load and unload times by weight (bandSawHandling), and the bars cut at once (maxPartsPerBundleBandSaw, the saw's
// stock limits). Pure. The cycle itself is the "Stock Machining - Band Saw" calculator's.
import { cutCodeFamilyOf } from '../shared/core/cut-code';

import type { KitRow } from '../shared/calculators/route-kit';

/** The stock in the saw's vise: its width and height (a round bar's diameter is both; a plate lies flat, its thickness the height). */
export interface SawStock {
  widthMm: number;
  heightMm: number;
  /** A round bar or tube's diameter, checked against the saw's largest round; null for any other stock. */
  diameterMm: number | null;
  /** Plate is cut one at a time. */
  plate: boolean;
}

/** A saw's stock limits (HR Rates specs max_stock_width_mm, max_stock_height_mm, max_stock_diameter_mm); null when the saw states none. */
export interface SawLimits {
  maxWidthMm: number | null;
  maxHeightMm: number | null;
  maxDiameterMm: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Why the stock does not go in the saw; null when it does. */
export function sawFit(stock: SawStock, limits: SawLimits): string | null {
  if (stock.diameterMm != null && limits.maxDiameterMm != null && stock.diameterMm > limits.maxDiameterMm + 1e-9) return `cuts round stock up to ${limits.maxDiameterMm} mm, the bar is Ø${r2(stock.diameterMm)}`;
  if (limits.maxWidthMm != null && stock.widthMm > limits.maxWidthMm + 1e-9) return `takes stock up to ${limits.maxWidthMm} mm wide, the cut is ${r2(stock.widthMm)} mm`;
  if (limits.maxHeightMm != null && stock.heightMm > limits.maxHeightMm + 1e-9) return `takes stock up to ${limits.maxHeightMm} mm high, the stock is ${r2(stock.heightMm)} mm`;
  return null;
}

export interface SawBundle {
  /** The bars cut at once. */
  bars: number;
  /** The width of the bundle in the cut: its bars side by side, then stacked. */
  widthMm: number;
  /** How many the saw's vise holds, and how many the batch needs: what set the bundle. */
  fits: number;
  barsForBatch: number;
  basis: string;
}

/**
 * The bars a saw cuts at once: as many as its vise holds (side by side across its stock width, stacked up to its stock height), within the
 * data's maxPartsPerBundleBandSaw, and never more bars than the batch needs. Plate is cut one at a time.
 */
export function sawBundle(stock: SawStock, limits: SawLimits, maxBundle: number, batchSize: number, partsPerStock: number): SawBundle {
  const barsForBatch = Math.max(1, Math.ceil(batchSize / Math.max(1, partsPerStock)));
  if (stock.plate) return { bars: 1, widthMm: stock.widthMm, fits: 1, barsForBatch, basis: 'plate is cut one at a time' };
  const across = limits.maxWidthMm != null ? Math.max(1, Math.floor((limits.maxWidthMm + 1e-9) / stock.widthMm)) : 1;
  const up = limits.maxHeightMm != null ? Math.max(1, Math.floor((limits.maxHeightMm + 1e-9) / stock.heightMm)) : 1;
  const fits = across * up;
  const bars = Math.max(1, Math.min(fits, Math.floor(maxBundle), barsForBatch));
  return {
    bars, widthMm: Math.min(bars, across) * stock.widthMm, fits, barsForBatch,
    basis: `${bars} bar${bars === 1 ? '' : 's'} a cut: the saw holds ${fits}, maxPartsPerBundleBandSaw ${maxBundle}, the batch needs ${barsForBatch}`,
  };
}

/**
 * The bandSawCutting row of a material at a width in the cut: its cut-code family's rows (the family is the cut code's whole number), the
 * first at or above the width, the widest for a wider cut (the table ends at 500 mm). `why` when the table lists none.
 */
export function sawRateRow(rows: readonly KitRow[], cutCode: number | null, widthMm: number): { row: KitRow; family: string } | { why: string } {
  const families = new Set(rows.map((r) => String(r['Material Cut Code Family'])));
  const family = cutCodeFamilyOf(families, cutCode);
  if (!family) return { why: `bandSawCutting lists no cut-code family for the material (cut code ${cutCode ?? 'none'})` };
  const own = rows.filter((r) => String(r['Material Cut Code Family']) === family && Number.isFinite(Number(r['Material Width (mm)'])))
    .sort((a, b) => Number(a['Material Width (mm)']) - Number(b['Material Width (mm)']));
  const row = own.find((r) => Number(r['Material Width (mm)']) >= widthMm - 1e-9) ?? own.at(-1);
  return row ? { row, family } : { why: `bandSawCutting has no rate for cut-code family ${family}` };
}

/** The bandSawHandling row for a weight: the first row at or above it (its last row holds any weight). */
export function sawHandlingRow(rows: readonly KitRow[], weightKg: number): KitRow | null {
  return [...rows].filter((r) => Number.isFinite(Number(r['Weight (kg)']))).sort((a, b) => Number(a['Weight (kg)']) - Number(b['Weight (kg)']))
    .find((r) => Number(r['Weight (kg)']) >= weightKg - 1e-9) ?? null;
}
