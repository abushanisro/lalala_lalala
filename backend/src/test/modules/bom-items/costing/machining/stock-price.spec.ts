/**
 * stock-price.ts: a machined part's material price comes from the stock form
 * the engine costs it on, at the quote location, from the real
 * memory/Plastic Modeling/machine/India/raw_material_stock_costs.csv rows
 * (what migration 833 stages; raw_material_name as its "Generic " link gives).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { closestStockPrice, machiningStockPriceForm, resolveStockPrice, STOCK_PRICE_FORMS, stockPriceFormOf, stockPriceOfForm, type StockPriceRow } from '../../../../../modules/bom-items/costing/machining/stock-price';

const CSV = join(__dirname, '../../../../../../../memory/plastic modeling/machine/India/raw_material_stock_costs.csv');
const FORMS: Record<string, string> = {
  Hex_Bar_USD_per_kg: 'hex_bar', Plate_USD_per_kg: 'plate', Rectangular_Bar_USD_per_kg: 'rectangular_bar',
  Round_Bar_USD_per_kg: 'round_bar', Round_Tube_USD_per_kg: 'round_tube', Square_Bar_USD_per_kg: 'square_bar',
};

function rows(): StockPriceRow[] {
  const lines = readFileSync(CSV, 'utf-8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const header = lines[0]!.split(',');
  const out: StockPriceRow[] = [];
  for (const line of lines.slice(1)) {
    // "Material" is quoted (it contains commas); the price columns are plain numbers.
    const m = /^"([^"]*)",(.*)$/.exec(line) ?? /^([^,]*),(.*)$/.exec(line)!;
    const prices = m[2]!.split(',');
    header.slice(1).forEach((col, i) => {
      if (prices[i]) out.push({ raw_material_name: `Generic ${m[1]}`, stock_form: FORMS[col]!, location: 'India', price_per_kg: prices[i]!, currency_code: 'USD', source: 'csv' });
    });
  }
  return out;
}
const ROWS = rows();

describe('stock-price', () => {
  it('prices milled parts on plate and turned / mill-turn parts on round bar', () => {
    expect(machiningStockPriceForm('milled')).toBe('plate');
    expect(machiningStockPriceForm('turned')).toBe('round_bar');
    expect(machiningStockPriceForm('mill_turn')).toBe('round_bar');
    expect(machiningStockPriceForm('sheet_metal')).toBeNull();
  });

  it('reads the real India prices: AISI 1006 plate 0.938, round bar 0.741 USD/kg', () => {
    expect(resolveStockPrice(ROWS, 'Generic Steel, Hot Worked, AISI 1006', 'milled', 'India'))
      .toMatchObject({ form: 'plate', pricePerKg: 0.938, currencyCode: 'USD' });
    expect(resolveStockPrice(ROWS, 'generic steel, hot worked, aisi 1006', 'turned', 'India'))
      .toMatchObject({ form: 'round_bar', pricePerKg: 0.741 });
  });

  it('has no stock price for another location or an unlisted material', () => {
    expect(resolveStockPrice(ROWS, 'Generic Steel, Hot Worked, AISI 1006', 'milled', 'USA')).toBeNull();
    expect(resolveStockPrice(ROWS, 'Generic Unobtainium', 'milled', 'India')).toBeNull();
  });
});

describe('a Stock Form chosen in the scenario is the form the material is priced on', () => {
  it('prices a milled part on the chosen form, and a billet on plate', () => {
    expect(machiningStockPriceForm('milled')).toBe('plate');
    expect(machiningStockPriceForm('milled', 'round_bar')).toBe('round_bar');
    expect(machiningStockPriceForm('milled', 'square_bar')).toBe('square_bar');
    expect(machiningStockPriceForm('milled', 'billet')).toBe('plate');
    expect(machiningStockPriceForm('turned', 'hex_bar')).toBe('hex_bar');
  });

  it('a family that is not machined has no stock price, whatever was chosen', () => {
    expect(machiningStockPriceForm('sheet_metal', 'round_bar')).toBeNull();
  });

  it('reads that form\'s own row', () => {
    const all = rows();
    const material = all[0]!.raw_material_name!;
    const round = resolveStockPrice(all, material, 'milled', 'India', 'round_bar');
    const plate = resolveStockPrice(all, material, 'milled', 'India');
    expect(round?.form).toBe('round_bar');
    expect(plate?.form).toBe('plate');
  });
});

describe('a stock the stock model chose is priced as its own form', () => {
  it('each form as itself, a billet as the plate it is sawn from, a tube as a tube (the stock model sizes one from the part\'s bore)', () => {
    for (const form of STOCK_PRICE_FORMS) expect(stockPriceFormOf(form)).toBe(form);
    expect(stockPriceFormOf('billet')).toBe('plate');
    expect(stockPriceFormOf('round_tube')).toBe('round_tube');
    // Where the stock model has not chosen the stock (a multi-spindle's part), a tube choice is priced as the plate a billet is sawn from.
    expect(machiningStockPriceForm('turned', 'round_tube')).toBe('plate');
    expect(stockPriceFormOf('i_beam')).toBeNull();
  });

  it('reads the form\'s own row at the location, whatever the family; none on file is no price', () => {
    const all = rows();
    const material = all[0]!.raw_material_name!;
    const tube = all.find((r) => r.raw_material_name === material && r.stock_form === 'round_tube' && r.location === 'India');
    expect(stockPriceOfForm(all, material, 'round_tube', 'India')?.pricePerKg ?? null).toBe(tube ? Number(tube.price_per_kg) : null);
    expect(stockPriceOfForm(all, material, 'plate', 'India')).toEqual(resolveStockPrice(all, material, 'milled', 'India'));
    expect(stockPriceOfForm(all, material, null, 'India')).toBeNull();
    expect(stockPriceOfForm(all, material, 'plate', 'USA')).toBeNull();
  });
});

// India's stock prices hold 71 to 90 materials per form of the USA's 105 (material_stock_prices). A material they do not hold is priced
// as its closest material they do hold, in the same form, and named (the plan's rule, user decision 2026-11-22; closestStockPrice). The
// material types and densities below are the local database's raw_materials rows of the India-priced materials (general catalog rows).
describe('a material India prices no stock of: the closest material India prices, named', () => {
  const ALUMINIUM: Record<string, number> = {
    'AA 3105': 2800, 'AA 380.0': 2900, 'AA 383.0': 2800, 'AA 7003': 2700, 'ANSI 3003': 2730, 'ANSI 3103': 2730, 'ANSI 5083': 2700, 'ANSI 5119': 2640,
    'ANSI 5251': 2680, 'ANSI 5454': 2700, 'ANSI 6012': 2750, 'ANSI 6061': 2700, 'ANSI 6082': 2700, 'ANSI 7020': 2770, 'ANSI 7022': 2780, 'ANSI 7075': 2810,
  };
  const COPPER = ['C27200', 'C28000', 'C51900', 'C62730'];
  const PROPERTIES = new Map<string, { materialType: string | null; densityKgM3: number | null }>([
    ...Object.entries(ALUMINIUM).map(([g, d]) => [`generic aluminum, ${g}`.toLowerCase(), { materialType: 'Aluminum', densityKgM3: d }] as const),
    ...COPPER.map((c) => [`generic copper, uns ${c}`.toLowerCase(), { materialType: 'Copper', densityKgM3: 8930 }] as const),
    ['generic steel, hot worked, aisi 1006', { materialType: 'Steel', densityKgM3: 7870 }],
  ]);
  const own = (grade: string, materialType: string, densityKgM3: number) => ({ name: grade.replace(/^Generic /, ''), grade, materialGroup: 'Ferrous & Non-Ferrous', materialType, densityKgM3 });
  // Aluminum, ANSI 2024: priced on round bar in the USA (6.235 USD/kg), not in India; its raw_materials row is Aluminum, 2770 kg/m3.
  const AL_2024 = own('Generic Aluminum, ANSI 2024', 'Aluminum', 2770);

  it('Aluminum ANSI 2024 round bar is priced as Aluminum ANSI 7020 (the same material type, the same density): 2.910 USD/kg', () => {
    expect(stockPriceOfForm(ROWS, AL_2024.grade, 'round_bar', 'India')).toBeNull();
    expect(closestStockPrice(ROWS, AL_2024, 'round_bar', 'India', PROPERTIES)).toEqual({
      form: 'round_bar', pricePerKg: 2.91, currencyCode: 'USD', source: 'csv',
      borrowed: { from: 'Generic Aluminum, ANSI 7020', by: 'the same material type, Aluminum' },
    });
    // Each form from the same closest material: its plate 3.684.
    expect(closestStockPrice(ROWS, AL_2024, 'plate', 'India', PROPERTIES)).toMatchObject({ pricePerKg: 3.684, borrowed: { from: 'Generic Aluminum, ANSI 7020' } });
  });

  it('a tie in density goes to the first by name', () => {
    // 2700 kg/m3: AA 7003, ANSI 5083, 5454, 6061, 6082 are all as near; "Generic Aluminum, AA 7003" is first by name.
    expect(closestStockPrice(ROWS, own('Generic Aluminum, ANSI 6060', 'Aluminum', 2700), 'round_bar', 'India', PROPERTIES)?.borrowed?.from).toBe('Generic Aluminum, AA 7003');
  });

  it('Copper UNS C11000 is priced as a copper India prices, never as an aluminium or a steel', () => {
    const borrowed = closestStockPrice(ROWS, own('Generic Copper, UNS C11000', 'Copper', 8930), 'round_bar', 'India', PROPERTIES);
    expect(borrowed?.borrowed).toEqual({ from: 'Generic Copper, UNS C27200', by: 'the same material type, Copper' });
    expect(borrowed?.pricePerKg).toBe(5.7);
  });

  it('a form India prices no copper in (round tube): nothing is borrowed, because a steel near in density is not a copper', () => {
    // The nearest density among the round tubes on file is a steel's (7870 against 8930). Borrowing by density alone priced a brass as an
    // Inconel 625; only the same grade, a variant or the same material type is close enough to say what this material costs.
    expect(closestStockPrice(ROWS, own('Generic Copper, UNS C11000', 'Copper', 8930), 'round_tube', 'India', PROPERTIES)).toBeNull();
  });

  it('none where India prices the material itself, at the reference\'s own location, or where nothing can be compared', () => {
    expect(closestStockPrice(ROWS, own('Generic Aluminum, ANSI 6061', 'Aluminum', 2700), 'round_bar', 'India', PROPERTIES)).toBeNull();
    expect(closestStockPrice(ROWS, AL_2024, 'round_bar', 'USA', PROPERTIES)).toBeNull();
    expect(closestStockPrice(ROWS, AL_2024, null, 'India', PROPERTIES)).toBeNull();
    expect(closestStockPrice(ROWS, null, 'round_bar', 'India', PROPERTIES)).toBeNull();
    // A material of no known type or density could be placed by name only: too far to borrow a price from.
    expect(closestStockPrice(ROWS, { name: 'Unobtainium', grade: 'Generic Unobtainium', materialGroup: null, materialType: null, densityKgM3: null }, 'round_bar', 'India', PROPERTIES)).toBeNull();
  });
});
