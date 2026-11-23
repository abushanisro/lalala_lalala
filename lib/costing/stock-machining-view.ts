import type { BOMItem, CostSummaryDto } from '@/lib/api/hooks/useBOMItems';
import type { FieldCommit } from '@/lib/costing/sand-scenario';
import type { FeatureNodeV2 } from '@/lib/types/manufacturing';

export type StockMachiningSummary = NonNullable<CostSummaryDto['stockMachining']>;
export type StockMachiningStock = NonNullable<StockMachiningSummary['stock']>;
export type StockMachiningOption = StockMachiningSummary['options'][number];
export type StockMachiningSaw = NonNullable<StockMachiningSummary['saw']>;
export type StockMachiningRoughing = NonNullable<StockMachiningSummary['roughing']>;
export type RoughingOption = StockMachiningRoughing['options'][number];
export type PlateCutOption = RoughingOption['processes'][number];

/** The process group of a part machined from bar or plate (backend stock-machining-route.ts STOCK_MACHINING_PROCESS_GROUP). */
export const STOCK_MACHINING_PROCESS_GROUP = 'Stock Machining';

/**
 * Whether an item's Process is Stock Machining (the backend's isStockMachining): the one Process whose quote costs sawing the stock to
 * pieces. Every machined part is cut from the same stock model's stock, so its cost summary carries the stock section either way.
 */
export function isStockMachiningItem(item: Pick<BOMItem, 'scenarioOverrides'> | null | undefined): boolean {
  return item?.scenarioOverrides?.processGroup === STOCK_MACHINING_PROCESS_GROUP;
}

/**
 * The scenario keys of the stock settings (backend scenario-overrides.ts: stockForm, stockAllowanceMm, stockSnap, stockRemnantMm,
 * stockScrapCredit, stockRoughingTechnique).
 */
export const STOCK_MACHINING_SCENARIO_KEYS = {
  form: 'stockForm', allowanceMm: 'stockAllowanceMm', snap: 'stockSnap', barEndMm: 'stockRemnantMm', scrapCredit: 'stockScrapCredit',
  roughingTechnique: 'stockRoughingTechnique',
} as const;

/** The stock forms the engine prices, as the backend names them (stock-selection.ts STOCK_FORMS). */
export const STOCK_FORM_LABELS: Readonly<Record<string, string>> = {
  round_bar: 'Round bar', hex_bar: 'Hex bar', rectangular_bar: 'Rectangular bar', square_bar: 'Square bar', plate: 'Plate', round_tube: 'Round tube', billet: 'Billet',
};
export const stockFormLabel = (form: string): string => STOCK_FORM_LABELS[form] ?? form;

/** How a part cut from plate is roughed out, as the backend names the techniques (plate-roughing.ts ROUGHING_TECHNIQUES). */
export const ROUGHING_TECHNIQUE_LABELS: Readonly<Record<string, string>> = {
  all_bulk_milling: 'All Bulk Milling', perimeter_milling_dropoff: 'Perimeter Milling with Drop-off', plate_cutting_dropoff: 'Plate Cutting with Drop-off',
};
export const roughingTechniqueLabel = (technique: string): string => ROUGHING_TECHNIQUE_LABELS[technique] ?? technique;

export interface StockMachiningOverrides {
  form: string | null;
  allowanceMm: number | null;
  snap: boolean | null;
  barEndMm: number | null;
  scrapCredit: boolean | null;
  roughingTechnique: string | null;
}

const nonNegative = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** The stock settings as the engine reads them: a value not of its kind is unset (the data's rule applies). 0 is a choice. */
export function stockMachiningOverridesOf(overrides: Record<string, unknown> | null | undefined): StockMachiningOverrides {
  const form = overrides?.[STOCK_MACHINING_SCENARIO_KEYS.form];
  const technique = overrides?.[STOCK_MACHINING_SCENARIO_KEYS.roughingTechnique];
  return {
    form: typeof form === 'string' && form in STOCK_FORM_LABELS ? form : null,
    allowanceMm: nonNegative(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.allowanceMm]),
    snap: flag(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.snap]),
    barEndMm: nonNegative(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.barEndMm]),
    scrapCredit: flag(overrides?.[STOCK_MACHINING_SCENARIO_KEYS.scrapCredit]),
    roughingTechnique: typeof technique === 'string' && technique in ROUGHING_TECHNIQUE_LABELS ? technique : null,
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

/**
 * The parts one bar or plate makes. Under a drop-off technique the plate makes outlines (the mill cuts round them) or cut blanks, not sawn
 * blanks.
 */
export function yieldLine(stock: StockMachiningStock, technique: string | null = null): string {
  if (!isPlateStock(stock)) return `${plural(stock.partsPerStock, 'piece')} per ${mm(stock.stockLengthMm)} bar`;
  if (stock.virtualPlate) return 'A plate cut to the blank (larger than the standard plate)';
  const made = technique === 'perimeter_milling_dropoff' ? 'outline' : technique === 'plate_cutting_dropoff' ? 'cut blank' : 'blank';
  return `${plural(stock.partsPerStock, made)} per ${num(stock.stockLengthMm)} × ${mm(stock.stockWidthMm ?? 0)} plate`;
}

/** What is lost between two parts and at the bar's end: a saw's kerf, a parting cut, or what a drop-off technique leaves between two parts. */
export function lossLine(stock: StockMachiningStock, technique: string | null = null): string {
  if (technique === 'perimeter_milling_dropoff') return `${mm(stock.cutWidthMm)} cutter width between parts and to the plate's edge`;
  if (technique === 'plate_cutting_dropoff') return `${mm(stock.cutWidthMm)} between cut parts`;
  const cut = `${mm(stock.cutWidthMm)} ${stock.cutOff === 'parting' ? 'parting cut' : 'saw kerf'} between pieces`;
  return stock.barEndMm != null ? `${cut} · ${mm(stock.barEndMm)} bar end` : cut;
}

/** The drop-off technique the quote prices, or null: a sawn blank (All Bulk Milling), and every bar. */
export function quotedDropoff(s: Pick<StockMachiningSummary, 'roughing'>): string | null {
  const technique = s.roughing?.technique ?? null;
  return technique != null && technique !== 'all_bulk_milling' ? technique : null;
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

/**
 * What a roughing technique costs a part: the plate bought, and what separates the part from it ("$2.37 plate + $0.44 Band Saw"). The
 * separation is left out where it is not costed (a saw the part's Process does not cost); null when the technique is not priced.
 */
export function roughingCostLine(option: RoughingOption, currencySymbol: string): string | null {
  if (option.materialCost == null) return null;
  const plate = `${currencySymbol}${option.materialCost.toFixed(2)} plate`;
  const cut = option.separation;
  return cut?.cost != null ? `${plate} + ${currencySymbol}${cut.cost.toFixed(2)} ${cut.process}` : plate;
}

/** What a technique makes of a plate, and what it leaves the mill: "40 per plate · 24,268.95 mm³ left for the mill". */
export function roughingYieldLine(option: RoughingOption): string | null {
  const parts = [
    ...(option.partsPerPlate != null ? [`${option.partsPerPlate} per plate`] : []),
    ...(option.bulkVolumeMm3 != null ? [`${option.bulkVolumeMm3.toLocaleString('en-US', { maximumFractionDigits: 2 })} mm³ left for the mill`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A plate cutting process beside the quoted one: its nest and cost, or why it is not priced. */
export function plateCutLine(process: PlateCutOption, currencySymbol: string): string {
  if (process.unavailable) return `${process.process}: ${process.unavailable}`;
  const cost = process.materialCost != null && process.cutCost != null
    ? ` · ${currencySymbol}${process.materialCost.toFixed(2)} plate + ${currencySymbol}${process.cutCost.toFixed(2)} cut` : '';
  return `${process.process}${process.chosen ? ' (quoted)' : ''}${process.partsPerPlate != null ? ` · ${process.partsPerPlate} per plate` : ''}${cost}`;
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
