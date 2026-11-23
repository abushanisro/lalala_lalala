import type { BOMItem, CostSummaryDto } from '@/lib/api/hooks/useBOMItems';
import type { FieldCommit } from '@/lib/costing/sand-scenario';
import type { FeatureNodeV2 } from '@/lib/types/manufacturing';

export type StockMachiningSummary = NonNullable<CostSummaryDto['stockMachining']>;
export type StockMachiningStock = NonNullable<StockMachiningSummary['stock']>;
export type StockMachiningOption = StockMachiningSummary['options'][number];
export type StockMachiningSaw = NonNullable<StockMachiningSummary['saw']>;

/** The process group of a part machined from bar or plate (backend stock-machining-route.ts STOCK_MACHINING_PROCESS_GROUP). */
export const STOCK_MACHINING_PROCESS_GROUP = 'Stock Machining';

/**
 * Whether an item's Process is Stock Machining (the backend's isStockMachining): the one Process whose quote costs sawing the stock to
 * pieces. Every machined part is cut from the same stock model's stock, so its cost summary carries the stock section either way.
 */
export function isStockMachiningItem(item: Pick<BOMItem, 'scenarioOverrides'> | null | undefined): boolean {
  return item?.scenarioOverrides?.processGroup === STOCK_MACHINING_PROCESS_GROUP;
}

/** The scenario keys of the stock settings (backend scenario-overrides.ts: stockForm, stockAllowanceMm, stockSnap, stockRemnantMm, stockScrapCredit). */
export const STOCK_MACHINING_SCENARIO_KEYS = {
  form: 'stockForm', allowanceMm: 'stockAllowanceMm', snap: 'stockSnap', barEndMm: 'stockRemnantMm', scrapCredit: 'stockScrapCredit',
} as const;

/** The stock forms the engine prices, as the backend names them (stock-selection.ts STOCK_FORMS). */
export const STOCK_FORM_LABELS: Readonly<Record<string, string>> = {
  round_bar: 'Round bar', hex_bar: 'Hex bar', rectangular_bar: 'Rectangular bar', square_bar: 'Square bar', plate: 'Plate', round_tube: 'Round tube', billet: 'Billet',
};
export const stockFormLabel = (form: string): string => STOCK_FORM_LABELS[form] ?? form;

export interface StockMachiningOverrides {
  form: string | null;
  allowanceMm: number | null;
  snap: boolean | null;
  barEndMm: number | null;
  scrapCredit: boolean | null;
}

const nonNegative = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** The stock settings as the engine reads them: a value not of its kind is unset (the data's rule applies). 0 is a choice. */
export function stockMachiningOverridesOf(overrides: Record<string, unknown> | null | undefined): StockMachiningOverrides {
  const form = overrides?.[STOCK_MACHINING_SCENARIO_KEYS.form];
  return {
    form: typeof form === 'string' && form in STOCK_FORM_LABELS ? form : null,
    allowanceMm: nonNegative(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.allowanceMm]),
    snap: flag(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.snap]),
    barEndMm: nonNegative(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.barEndMm]),
    scrapCredit: flag(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.scrapCredit]),
  };
}

/** A number of 0 or more, or an empty field (clears the choice): 0 stock allowance and 0 bar end are choices. */
export function parseNonNegative(text: string): FieldCommit {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : 'invalid';
}

/** A yes / no setting as a select's value ('' is unset: the data's rule), and back. */
export const flagValue = (v: boolean | null): '' | 'on' | 'off' => (v == null ? '' : v ? 'on' : 'off');
export const flagOf = (value: string): boolean | null => (value === 'on' ? true : value === 'off' ? false : null);

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const mm = (n: number) => `${num(n)} mm`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Whether the stock is bought as plate (a plate has a width; a billet is a block cut from plate). */
export const isPlateStock = (stock: StockMachiningStock): boolean => stock.stockWidthMm != null;

/** What the part needed of the stock before the size snapped: "needs Ø15.59 mm", "needs 28.2 × 22.1 mm", "needs 9.6 mm thick". */
export function neededLine(stock: StockMachiningStock): string {
  const a = num(stock.requiredAMm);
  const needs = stock.form === 'round_bar' ? `Ø${a} mm`
    : stock.form === 'round_tube' ? `Ø${a} mm${stock.requiredBMm != null ? ` over a ${mm(stock.requiredBMm)} bore` : ''}`
      : stock.form === 'hex_bar' ? `${a} mm across flats`
        : stock.form === 'square_bar' ? `${a} mm a side`
          : stock.form === 'rectangular_bar' && stock.requiredBMm != null ? `${a} × ${mm(stock.requiredBMm)}`
            : `${a} mm thick`;
  return `needs ${needs}${stock.snapped ? '' : ', bought at that size'}`;
}

/** The stock left on the part: on each side of its section, and on each end. */
export function allowanceLine(stock: StockMachiningStock): string {
  return `${mm(stock.allowancePerSideMm)} a side · ${mm(stock.endAllowanceMm)} each end`;
}

/** The piece cut for one part: a bar's length, a plate blank's three sizes. */
export function pieceLine(stock: StockMachiningStock): string {
  const { lengthMm, widthMm, thicknessMm } = stock.piece;
  return widthMm != null && thicknessMm != null ? `${num(lengthMm)} × ${num(widthMm)} × ${mm(thicknessMm)}` : `${mm(lengthMm)} long`;
}

/** The parts one bar or plate makes. */
export function yieldLine(stock: StockMachiningStock): string {
  if (!isPlateStock(stock)) return `${plural(stock.partsPerStock, 'piece')} per ${mm(stock.stockLengthMm)} bar`;
  if (stock.virtualPlate) return 'A plate cut to the blank (larger than the standard plate)';
  return `${plural(stock.partsPerStock, 'blank')} per ${num(stock.stockLengthMm)} × ${mm(stock.stockWidthMm ?? 0)} plate`;
}

/** What is lost between two parts and at the bar's end. */
export function lossLine(stock: StockMachiningStock): string {
  const cut = `${mm(stock.cutWidthMm)} ${stock.cutOff === 'parting' ? 'parting cut' : 'saw kerf'} between pieces`;
  return stock.barEndMm != null ? `${cut} · ${mm(stock.barEndMm)} bar end` : cut;
}

/** The bars or plates the batch needs. */
export function batchLine(stock: StockMachiningStock): string {
  return `${plural(stock.stocksForBatch, isPlateStock(stock) ? 'plate' : 'bar')} for the batch`;
}

/** What the saw cuts at once: bars in a bundle, or one plate. */
export function bundleLine(saw: StockMachiningSaw, stock: StockMachiningStock | null): string {
  return stock && isPlateStock(stock) ? 'one plate at a time' : `${plural(saw.bundleBars, 'bar')} a cut`;
}

/** The saw's cycle for one piece, part by part, and its total. */
export function sawTimesLine(saw: StockMachiningSaw): string {
  return `cut ${num(saw.cutSec)} s · feed ${num(saw.feedSec)} s · load ${num(saw.loadSec)} s · unload ${num(saw.unloadSec)} s = ${num(saw.cycleSec)} s a piece`;
}

/** What a form costs a part: the stock bought, and its sawing ("$0.53 + $0.23 saw"); null when the form is not priced. */
export function optionCostLine(option: StockMachiningOption, currencySymbol: string): string | null {
  if (option.materialCost == null) return null;
  const stock = `${currencySymbol}${option.materialCost.toFixed(2)}`;
  return option.sawCost != null && option.sawCost > 0 ? `${stock} + ${currencySymbol}${option.sawCost.toFixed(2)} saw` : stock;
}

/** The catalog's process of the stock itself. The stock is bought, not made, so it has no cost line: the process tree lists it first. */
export const MATERIAL_STOCK_STEP = 'Material Stock';

export interface MaterialStockFeature { key: 'curved' | 'planar'; label: string; featureType: string; faceIds: number[] }

/** The Material Stock step's features as the catalog names them: the faces left as the stock supplies them, curved then flat. */
export function materialStockFeatures(s: Pick<StockMachiningSummary, 'asSuppliedFaceIds'>): MaterialStockFeature[] {
  const all: MaterialStockFeature[] = [
    { key: 'curved', label: 'As Supplied // CurvedWall', featureType: 'CurvedWall', faceIds: [...s.asSuppliedFaceIds.curvedWall] },
    { key: 'planar', label: 'As Supplied // PlanarFace', featureType: 'PlanarFace', faceIds: [...s.asSuppliedFaceIds.planarFace] },
  ];
  return all.filter((f) => f.faceIds.length > 0);
}

/**
 * Faces of the part as a 3D highlight, named by the feature they are (CurvedWall, PlanarFace, StockTrim). Their positions are not known
 * here: the viewer measures the centre from the faces' own triangles (centroidFromFaces), as the process tree's face highlights do. Null
 * without faces.
 */
export function facesHighlight(id: string, featureType: string, faceIds: readonly number[]): FeatureNodeV2 | null {
  if (faceIds.length === 0) return null;
  return {
    id,
    feature_type: featureType as FeatureNodeV2['feature_type'],
    occurrences: [{ centroid: [0, 0, 0], face_ids: [...faceIds] }],
    centroidFromFaces: true,
  };
}
