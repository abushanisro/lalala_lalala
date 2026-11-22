import type { StockMachiningOption, StockMachiningSaw, StockMachiningStock, StockMachiningSummary } from '@/lib/costing/stock-machining-view';

// Stock Machining sections as the engine returned them on the local stack (aluminium 6061, batch 100, 2026-11-22), money in USD.

const BAR_END_NOTE = 'Bar end that makes no part: automatic band saws leave 35-190 mm, bar feeders 2-6 in; 6 in taken (saw builders\' published remnant lengths; Production Machining, "Bar feeder basics")';
const NO_BORE = 'a tube is stock for a part with a bore through its whole length on its axis; this part has none';

export const SHAFT_INDIA_STOCK: StockMachiningStock = {
  form: 'round_bar', sizeLabel: '16 mm round bar', boughtAMm: 16, boughtBMm: null, requiredAMm: 15.588, requiredBMm: null,
  allowancePerSideMm: 0.794, endAllowanceMm: 0.794, snapped: true, unitSystem: 'metric',
  piece: { lengthMm: 33.588, widthMm: null, thicknessMm: null }, cutWidthMm: 0.889, cutOff: 'saw',
  partsPerStock: 172, stocksForBatch: 1, stockLengthMm: 6096, stockWidthMm: null, virtualPlate: false, barEndMm: 152.4, utilizationPct: 37.1,
  purchasedKg: 0.01924, pieceKg: 0.018234, partKg: 0.007144,
};

export const SHAFT_INDIA_SAW: StockMachiningSaw = {
  machineName: 'DoAll 3613-1 Vert', bundleBars: 1, bundleBasis: '1 bar a cut: the saw holds 1120, maxPartsPerBundleBandSaw 18, the batch needs 1',
  cuttingRateMm2Min: 8064.5, cutSec: 1.496, feedSec: 0.46, loadSec: 0.116, unloadSec: 5, cycleSec: 7.072,
};

/** The Lead Screw side shaft (Ø14 x 32 mm, mill-turn) in India: sawn from a 16 mm round bar. */
export const SHAFT_INDIA: StockMachiningSummary = {
  rule: { form: 'round_bar', basis: 'a turned part, 14 mm at its largest diameter' },
  stock: SHAFT_INDIA_STOCK,
  fallback: null,
  options: [
    { form: 'round_bar', sizeLabel: '16 mm round bar', unavailable: null, materialCost: 0.0569, sawCost: 0.02, chosen: true },
    { form: 'hex_bar', sizeLabel: '14 mm A/F hex bar', unavailable: null, materialCost: 0.0542, sawCost: 0.02, chosen: false },
    { form: 'rectangular_bar', sizeLabel: '16 mm x 16 mm rectangular bar', unavailable: null, materialCost: 0.0883, sawCost: 0.02, chosen: false },
    { form: 'square_bar', sizeLabel: '16 mm x 16 mm square bar', unavailable: null, materialCost: 0.0843, sawCost: 0.02, chosen: false },
    { form: 'plate', sizeLabel: '16 mm plate, 33.588 x 15.588 mm blank', unavailable: null, materialCost: 0.0945, sawCost: 0.02, chosen: false },
    { form: 'round_tube', sizeLabel: '16 mm x 6 mm bore round tube', unavailable: null, materialCost: 0.0643, sawCost: 0.02, chosen: false },
    { form: 'billet', sizeLabel: '33.588 x 15.588 x 15.588 mm billet', unavailable: null, materialCost: 0.0921, sawCost: 0.02, chosen: false },
  ],
  saw: SHAFT_INDIA_SAW,
  sawMissing: null,
  scrapCredit: { enabled: false, percent: 9, credit: 0 },
  partSource: 'measured',
  asSuppliedFaceIds: { curvedWall: [], planarFace: [] },
  endFaceIds: [5, 22],
  stockLabel: '16 mm round bar, 33.59 mm piece, 172 per 6096 mm bar',
  notes: [BAR_END_NOTE],
};

export const SHAFT_USA_STOCK: StockMachiningStock = {
  form: 'round_bar', sizeLabel: 'Ø14 mm round bar', boughtAMm: 14, boughtBMm: null, requiredAMm: 14, requiredBMm: null,
  allowancePerSideMm: 0, endAllowanceMm: 0, snapped: false, unitSystem: 'US',
  piece: { lengthMm: 32, widthMm: null, thicknessMm: null }, cutWidthMm: 2.5, cutOff: 'parting',
  partsPerStock: 172, stocksForBatch: 1, stockLengthMm: 6096, stockWidthMm: null, virtualPlate: false, barEndMm: 152.4, utilizationPct: 48.5,
  purchasedKg: 0.014731, pieceKg: 0.0133, partKg: 0.007144,
};

/** The same shaft in the USA with 0 allowance and no snapping: a Ø14 bar whose surface is the part's, parted off on a bar-fed lathe. */
export const SHAFT_USA_AS_SUPPLIED: StockMachiningSummary = {
  rule: { form: 'round_bar', basis: 'a turned part, 14 mm at its largest diameter' },
  stock: SHAFT_USA_STOCK,
  fallback: null,
  options: [
    { form: 'round_bar', sizeLabel: 'Ø14 mm round bar', unavailable: null, materialCost: 0.0865, sawCost: null, chosen: true },
    { form: 'hex_bar', sizeLabel: '14 mm A/F hex bar', unavailable: null, materialCost: 0.1078, sawCost: null, chosen: false },
  ],
  saw: null,
  sawMissing: 'A bar-fed lathe takes the whole bar and parts each piece off: no band saw cuts it.',
  scrapCredit: { enabled: false, percent: 9, credit: 0 },
  partSource: 'measured',
  asSuppliedFaceIds: { curvedWall: [9], planarFace: [] },
  endFaceIds: [5, 22],
  stockLabel: 'Ø14 mm round bar, 32 mm piece, 172 per 6096 mm bar',
  notes: ['Stock on each side set in the Cost Guide: 0 mm.', 'Snapping to preferred sizes set in the Cost Guide: off.', BAR_END_NOTE],
};

export const STIFFNER_PLATE_STOCK: StockMachiningStock = {
  form: 'plate', sizeLabel: '1/2" plate, 163.7 x 46.2 mm blank', boughtAMm: 12.7, boughtBMm: null, requiredAMm: 12.2, requiredBMm: null,
  allowancePerSideMm: 2.1, endAllowanceMm: 2.1, snapped: true, unitSystem: 'US',
  piece: { lengthMm: 163.7, widthMm: 46.2, thicknessMm: 12.7 }, cutWidthMm: 0.889, cutOff: 'saw',
  partsPerStock: 45, stocksForBatch: 3, stockLengthMm: 914.4, stockWidthMm: 457.2, virtualPlate: false, barEndMm: null, utilizationPct: 12.9,
  purchasedKg: 0.318565, pieceKg: 0.259333, partKg: 0.041063,
};

/** STIFFNER 2 (159.5 x 42 x 8 mm, milled) in the USA, set to plate with the scrap credit on. */
export const STIFFNER_PLATE: StockMachiningSummary = {
  rule: { form: 'rectangular_bar', basis: 'its section is 42 x 8 mm' },
  stock: STIFFNER_PLATE_STOCK,
  fallback: null,
  options: [
    { form: 'round_bar', sizeLabel: '2" round bar', unavailable: null, materialCost: 4.9759, sawCost: 0.37, chosen: false },
    { form: 'rectangular_bar', sizeLabel: '2" x 1/2" rectangular bar', unavailable: null, materialCost: 1.9505, sawCost: 0.23, chosen: false },
    { form: 'plate', sizeLabel: '1/2" plate, 163.7 x 46.2 mm blank', unavailable: null, materialCost: 2.1837, sawCost: 0.44, chosen: true },
    { form: 'round_tube', sizeLabel: null, unavailable: NO_BORE, materialCost: null, sawCost: null, chosen: false },
    { form: 'billet', sizeLabel: '163.7 x 46.2 x 12.2 mm billet', unavailable: null, materialCost: 2.0988, sawCost: 0.43, chosen: false },
  ],
  saw: {
    machineName: 'DoAll 3613-1 Vert', bundleBars: 1, bundleBasis: 'plate is cut one at a time',
    cuttingRateMm2Min: 8064.5, cutSec: 19.833, feedSec: 2.195, loadSec: 0.667, unloadSec: 5, cycleSec: 27.694,
  },
  sawMissing: null,
  scrapCredit: { enabled: true, percent: 9, credit: 0.18576533874060722 },
  partSource: 'measured',
  asSuppliedFaceIds: { curvedWall: [], planarFace: [] },
  endFaceIds: [9, 15],
  stockLabel: '1/2" plate, 163.7 x 46.2 mm blank, 45 per 914.4 x 457.2 mm plate',
  notes: [BAR_END_NOTE],
};

/** STIFFNER 2 set to round tube: it has no bore, so the engine prices a billet and says why. */
export const STIFFNER_TUBE_ASKED: StockMachiningSummary = {
  ...STIFFNER_PLATE,
  stock: {
    ...STIFFNER_PLATE_STOCK, form: 'billet', sizeLabel: '163.7 x 46.2 x 12.2 mm billet', boughtAMm: 12.2, snapped: false,
    piece: { lengthMm: 163.7, widthMm: 46.2, thicknessMm: 12.2 }, utilizationPct: 13.4, purchasedKg: 0.306023, pieceKg: 0.249123,
  },
  fallback: `The Cost Guide's round tube is not available: ${NO_BORE}. Priced as a billet cut from plate.`,
  options: STIFFNER_PLATE.options.map((o) => ({ ...o, chosen: o.form === 'billet' })),
  scrapCredit: { enabled: false, percent: 9, credit: 0 },
  stockLabel: '163.7 x 46.2 x 12.2 mm billet, 45 per 914.4 x 457.2 mm plate',
};

/** A form's row of a quote's options. */
export function optionOf(s: StockMachiningSummary, form: string): StockMachiningOption {
  const option = s.options.find((o) => o.form === form);
  if (!option) throw new Error(`the quote lists no ${form}`);
  return option;
}
