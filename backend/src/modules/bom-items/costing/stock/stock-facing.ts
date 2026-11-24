// What a mill faces off the stock piece before the part's features are cut: the faces the stock model leaves stock on, and how much. Pure.
//
// The machining workbook's Face Milling sheet times a face from its length, its width and the total depth to cut on it. The stock model
// (stock-selection.ts) states each of them for the piece it chose:
//
//   plate, billet,             the piece's top and bottom, its length x width (a drop-off technique's piece: its outline's area), with
//   rectangular / square bar   the piece's thickness less the part's height split between them. The part sits in the middle of it: the
//                              allowance is the same on each side.
//   round bar, hex bar,        the two sawn ends, across the bar's corners, with the stock model's end allowance on each.
//   round tube
//
// The volume faced is taken off the stock the Bulk Milling operation removes (stock-excess.ts), so no stock is milled twice.

import type { StockOption, StockPart } from './stock-selection';

export interface StockFacing {
  /** The faces with stock on them (2, or none: a piece with no stock on its faces has no facing). */
  faces: number;
  /** The face's length and width (mm): what the face mill travels along and steps across. */
  lengthMm: number;
  widthMm: number;
  /** The stock on each face (mm). */
  depthMm: number;
  /** The volume faced off the piece, every face (mm^3). */
  volumeMm3: number;
  /** What each value is, for a calculation's source text. */
  basis: string;
}

/** Stock thinner than this on a face is the piece's rounding, not stock to face (mm). */
const NO_STOCK_MM = 0.001;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The facing of the piece `option` cuts for `part`; null when the piece has no stock on the faces a mill faces. */
export function stockFacing(option: StockOption, part: StockPart): StockFacing | null {
  if (option.form === 'round_bar' || option.form === 'hex_bar' || option.form === 'round_tube') {
    const depthMm = option.endAllowanceMm;
    const acrossMm = option.circumscribedMm ?? option.aMm;
    const areaMm2 = option.sectionAreaMm2;
    if (!(depthMm > NO_STOCK_MM) || !(acrossMm > 0) || areaMm2 == null || !(areaMm2 > 0)) return null;
    return {
      faces: 2, lengthMm: acrossMm, widthMm: acrossMm, depthMm, volumeMm3: 2 * areaMm2 * depthMm,
      basis: `the ${option.sizeLabel} piece's two sawn ends, Ø${r3(acrossMm)} mm across its corners, with the ${r3(depthMm)} mm end allowance on each`,
    };
  }
  // A block: its top and bottom. A bar's section is its width (a) by its height (b); a plate's or billet's thickness is the blank's.
  const isBar = option.form === 'rectangular_bar' || option.form === 'square_bar';
  const thicknessMm = isBar ? (option.bMm ?? option.aMm) : option.blank.thicknessMm;
  const widthMm = isBar ? option.aMm : option.blank.widthMm;
  const lengthMm = option.blank.lengthMm;
  if (thicknessMm == null || widthMm == null || !(lengthMm > 0) || !(widthMm > 0)) return null;
  const totalMm = thicknessMm - part.heightMm;
  if (!(totalMm / 2 > NO_STOCK_MM)) return null;
  // A drop-off technique's piece is the part's outline through the plate, not its bounding rectangle.
  const areaMm2 = option.roughing ? option.roughing.piece.areaMm2 : lengthMm * widthMm;
  return {
    faces: 2, lengthMm, widthMm, depthMm: totalMm / 2, volumeMm3: areaMm2 * totalMm,
    basis: `the ${option.sizeLabel} piece's top and bottom, ${r3(lengthMm)} x ${r3(widthMm)} mm, with its ${r3(thicknessMm)} mm thickness less the part's ${r3(part.heightMm)} mm height split between them`,
  };
}
