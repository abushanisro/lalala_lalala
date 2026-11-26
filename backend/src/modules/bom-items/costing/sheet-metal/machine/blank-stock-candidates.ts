// The stock a machining engine starts from (BlankResult), and the bounding-box billet of a sheet-metal part's "machine from solid billet"
// alternative (billetFallback). Pure: no NestJS or database dependency.
//
// A machined part's stock is chosen by the stock model (costing/stock), which stock-machining-cost-summary.ts stockBlankResult hands the
// engines as a BlankResult. The picker that once scored stock_profiles candidates here is gone (user decision 2026-11-22: one stock model).

import type { SourceRef } from '../../../dto/cost-breakdown.dto';
import type { StockFacing } from '../../stock/stock-facing';

export interface BoundingBox {
  length: number; // mm — longest dimension (feed direction)
  width: number; // mm
  height: number; // mm
}

// The machining stock forms the reference prices (memory/Stock Maching/metirials/materials_band_saw.csv: Hex Bar,
// Plate, Rectangular Bar, Round Bar, Round Tube, Square Bar), plus 'billet': a block sawn to the part's own size.
export type StockForm = 'round_bar' | 'hex_bar' | 'rectangular_bar' | 'square_bar' | 'plate' | 'round_tube' | 'billet';

export interface BlankResult {
  form: string;
  sizeLabel: string;
  /** The piece the machine starts from (mm³): what is machined away is taken off it. */
  billetVolMm3: number;
  utilizationPct: number | null;
  /** The circle round a bar's corners: the diameter a lathe turns down from. Absent for plate and billet. */
  barDiameterMm?: number;
  /** The Cost Guide's stock form, when it cannot hold the part and the stock is a billet instead, with why. */
  requestedFormUnavailable?: { requested: StockForm; reason: string };
  /** billetFallback only: the per-side machining stock allowance applied (reference
   *  rule, costing/machining/stock-allowance.ts); null when the rule's
   *  variables are not staged, so no allowance was added. */
  stockAllowancePerSideMm?: number | null;
  /**
   * The stock model's choice (costing/stock): purchasedVolMm3 is the stock bought per part (the piece's share of a whole bar or plate,
   * what the material is priced on) and sizeSource what chose the stock.
   */
  purchasedVolMm3?: number;
  sizeSource?: string;
  /** The stock model's choice: the stock left on each end of the piece (the lathe faces it off), and a tube's bore (a part-off cuts the wall only). */
  endAllowanceMm?: number;
  tubeIdMm?: number;
  /** The stock model's choice: what a mill faces off the piece before the part's features (stock/stock-facing.ts). Absent: nothing to face. */
  facing?: StockFacing;
  /** The stock model's choice: how the bar's diameter and its end allowance were arrived at, for the eye beside the inputs that read them. */
  barDiameterRef?: SourceRef;
  endAllowanceRef?: SourceRef;
}

export function billetFallback(
  bbox: BoundingBox,
  partVolMm3: number,
  // Per-side allowance from the reference rule (stock-allowance.ts), resolved
  // by the caller; null = rule not staged, so none is added (and the caller
  // discloses it) rather than a coded number standing in.
  allowancePerSideMm: number | null,
): BlankResult {
  const allow = 2 * (allowancePerSideMm ?? 0);
  const vol = (bbox.length + allow) * (bbox.width + allow) * (bbox.height + allow);
  const util = vol > 0 && partVolMm3 > 0 ? (partVolMm3 / vol) * 100 : null;
  return {
    form: "billet",
    sizeLabel: `${(bbox.length + allow).toFixed(0)}×${(bbox.width + allow).toFixed(0)}×${(bbox.height + allow).toFixed(0)} billet`,
    billetVolMm3: vol,
    utilizationPct: util !== null ? Math.min(100, util) : null,
    stockAllowancePerSideMm: allowancePerSideMm,
  };
}
