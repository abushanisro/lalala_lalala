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
// keeps its raw_materials price and says a form price is not on file.

import { isTurnedFamily } from '../../../../domain/part-family';

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

interface StockPrice {
  form: StockPriceForm;
  pricePerKg: number;
  currencyCode: string;
  source: string;
}

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
