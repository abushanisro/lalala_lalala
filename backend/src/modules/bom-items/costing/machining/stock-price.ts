// Material price for the stock form a machined blank is cut from, at the quote
// location: material_stock_prices (migration 833; memory/Plastic Modeling/
// machine/India/raw_material_stock_costs.csv). Pure; the caller loads the rows.
//
// The priced form is the stock the material is costed on. A machined part's is
// the form its stock model chose (stockPriceFormOf). Where the stock model does
// not choose the stock (a multi-spindle's part; a part whose stock could not be
// chosen) it is the family's own (machiningStockPriceForm):
//   milled            -> plate      (the milled family's first preferred shape,
//                                    material-shape-ranking.ts)
//   turned, mill_turn -> round_bar  (bar stock, computeTurningCostSummary)
// No price for that material, form and location = no stock price: the quote
// keeps its raw_materials price and says a form price is not on file. Except
// where the location's prices are a partial copy of the reference's (India):
// there a material missing from them is priced as its closest material that
// is on them, in the same form, and named (closestStockPrice).

import { isTurnedFamily } from '../../../../domain/part-family';
import { closestProcessMaterial, type OwnMaterial, type ProcessMaterial } from '../shared/core/process-materials';

export type StockPriceForm = 'round_bar' | 'hex_bar' | 'rectangular_bar' | 'square_bar' | 'round_tube' | 'plate';
/** The forms machining stock is priced in (memory/Stock Maching materials). */
export const STOCK_PRICE_FORMS: readonly StockPriceForm[] = ['round_bar', 'hex_bar', 'rectangular_bar', 'square_bar', 'round_tube', 'plate'];

export interface StockPriceRow {
  raw_material_name: string | null;
  stock_form: string;
  location: string;
  price_per_kg: number | string;
  currency_code: string;
  source: string;
}

// The form priced when the stock model has not chosen the stock: a Stock Form chosen in the scenario is priced as
// that form (a billet is sawn from plate); with no choice the family's own stock applies.
export function machiningStockPriceForm(family: string, chosenForm?: string | null): StockPriceForm | null {
  if (chosenForm && (family === 'milled' || isTurnedFamily(family))) {
    // A billet is sawn from plate. A round tube is sized from the part's bore, which only the stock model reads:
    // without its choice a tube is priced as the plate a billet is sawn from.
    return chosenForm === 'billet' || chosenForm === 'round_tube' ? 'plate' : (chosenForm as StockPriceForm);
  }
  if (family === 'milled') return 'plate';
  if (isTurnedFamily(family)) return 'round_bar';
  return null;
}

/**
 * The form a stock the stock model chose (costing/stock) is priced as: the form itself, a billet as the plate it is sawn from. A tube is
 * priced as a tube: the stock model sizes one from the part's bore.
 */
export function stockPriceFormOf(stockForm: string): StockPriceForm | null {
  if (stockForm === 'billet') return 'plate';
  return (STOCK_PRICE_FORMS as readonly string[]).includes(stockForm) ? (stockForm as StockPriceForm) : null;
}

export interface StockPrice {
  form: StockPriceForm;
  pricePerKg: number;
  currencyCode: string;
  source: string;
  /** Set when the price is another material's (closestStockPrice): that material, and why it is the closest. */
  borrowed?: { from: string; by: string };
}

/**
 * The location whose stock prices are the reference's own (memory/Stock Maching, Multi-Spindle and Bar and Tube exports: 105 materials in
 * each machining form). A material it does not price has no stock price there and keeps its own raw_materials USA price, as before.
 */
export const REFERENCE_STOCK_PRICE_LOCATION = 'USA';

export function resolveStockPrice(
  rows: readonly StockPriceRow[],
  materialName: string | null | undefined,
  family: string,
  location: string,
  chosenForm?: string | null,
): StockPrice | null {
  return stockPriceOfForm(rows, materialName, machiningStockPriceForm(family, chosenForm), location);
}

/** The price on file for a material in one stock form at a location; null when there is none. */
export function stockPriceOfForm(
  rows: readonly StockPriceRow[],
  materialName: string | null | undefined,
  form: StockPriceForm | null,
  location: string,
): StockPrice | null {
  if (!form || !materialName) return null;
  const row = rows.find((r) =>
    r.raw_material_name != null && r.raw_material_name.toLowerCase() === materialName.toLowerCase()
    && r.stock_form === form && r.location === location);
  const price = row ? Number(row.price_per_kg) : NaN;
  if (!row || !(price > 0)) return null;
  return { form, pricePerKg: price, currencyCode: row.currency_code, source: row.source };
}

/**
 * The price of a material the location's stock prices do not hold, in a location whose prices are a partial copy of the reference's
 * (India holds 71 to 90 materials per form of the USA's 105): the price of its closest material that the location prices in the same
 * form, named. Closest is the established rule (process-materials.ts closestProcessMaterial: the same material type, then the nearest
 * density); a material with no type or density to compare is too far to borrow from, and has no stock price. This is the
 * plan's rule for India stock (user decision 2026-11-22). Without it such a material fell back to its raw_materials row, whose India
 * price is held in USD and was read as rupees: Aluminum ANSI 2024 round bar in India cost 2.99 INR/kg, 0.03 USD.
 *
 * `properties` holds the material type and density of the materials the location prices, by their stock price name. Null when the
 * location prices the material itself, is the reference's own location, or nothing close enough is priced there.
 */
export function closestStockPrice(
  rows: readonly StockPriceRow[],
  own: OwnMaterial | null,
  form: StockPriceForm | null,
  location: string,
  properties: ReadonlyMap<string, { materialType: string | null; densityKgM3: number | null }>,
): StockPrice | null {
  if (!form || !own || location === REFERENCE_STOCK_PRICE_LOCATION) return null;
  const priced = rows.filter((r) => r.raw_material_name != null && r.stock_form === form && r.location === location && Number(r.price_per_kg) > 0);
  const named = (name: string | null) => !!name && priced.some((r) => r.raw_material_name!.toLowerCase() === name.toLowerCase());
  if (named(own.grade) || named(own.name)) return null;
  const materials: ProcessMaterial[] = priced.map((r) => ({
    name: r.raw_material_name!, grade: null,
    materialType: properties.get(r.raw_material_name!.toLowerCase())?.materialType ?? null,
    densityKgM3: properties.get(r.raw_material_name!.toLowerCase())?.densityKgM3 ?? null,
  }));
  const closest = closestProcessMaterial([own], materials);
  if (!closest || closest.by === 'unplaced') return null;
  const price = stockPriceOfForm(priced, closest.material.name, form, location);
  if (!price) return null;
  const by = closest.by === 'material type' ? `the same material type, ${closest.material.materialType}`
    : closest.by === 'grade' ? 'the same grade' : closest.by === 'variant' ? `a variant of "${own.name ?? own.grade ?? ''}"` : 'the nearest density';
  return { ...price, borrowed: { from: closest.material.name, by } };
}
