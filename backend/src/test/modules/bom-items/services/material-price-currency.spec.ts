/**
 * The material price every family's quote is built on (MaterialResolutionService.resolveMaterialForFamily) and the sheet-metal scrap
 * price (BomItemCostingService.sheetScrapPricePerKg) read raw_materials' location prices as USD per kg and convert them to the quote's
 * currency (material-location-price.ts). The defect: the location's column was taken as the location's currency, so Aluminum AA 7003
 * (cost_usa 5.726, cost_india 2.72 on the local database) cost 2.72 rupees a kg in India, 0.029 USD.
 */
import { BomItemCostingService } from '../../../../modules/bom-items/bom-item-costing.service';
import { LOCATION_INFO } from '../../../../modules/bom-items/costing/shared/core/default-rates.constants';
import { MaterialResolutionService } from '../../../../modules/bom-items/services/material-resolution.service';
import type { RateSnapshot } from '../../../../common/exchange-rate/exchange-rate.service';

/** A snapshot as ExchangeRateService builds one (USD per unit), at the reference rates of 2026-11-16. */
function snapshot(usdPer: Record<string, number>): RateSnapshot {
  const per = new Map(Object.entries({ USD: 1, ...usdPer }));
  const convertOptional = (from: string, to: string) => {
    if (from === to) return 1;
    const f = per.get(from);
    const t = per.get(to);
    return f == null || t == null ? null : f / t;
  };
  const convertStrict = (from: string, to: string) => {
    const r = convertOptional(from, to);
    if (r == null) throw new Error(`No exchange rate on file for '${from}' → '${to}'`);
    return r;
  };
  return { convertOptional, convertStrict, toUsd: (a, from) => a * convertStrict(from, 'USD'), has: (c) => per.has(c), rates: () => Object.fromEntries(per), organizationId: null };
}
const RATES = snapshot({ INR: 1 / 93.93, CNY: 1 / 6.6665 });

/** A data API that answers every raw_materials read with `rows` and every other table with nothing: no alias, no stock price. */
function client(rows: Array<Record<string, unknown>>) {
  return {
    from: (table: string) => {
      const data = table === 'raw_materials' ? rows : [];
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'ilike', 'or', 'not', 'in', 'order', 'limit', 'range']) builder[m] = () => builder;
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve, reject);
      return builder;
    },
  };
}

// The general catalog's Aluminum AA 7003 (Ferrous & Non-Ferrous), as the local database holds it; it has no China price of its own here.
const AA_7003 = {
  id: 'aa7003', name: 'Aluminum, AA 7003', grade: 'Generic Aluminum, AA 7003', material_group: 'Ferrous & Non-Ferrous', material_type: 'Aluminum',
  density_kg_m3: 2700, cost_usa: 5.726, cost_india: 2.72, cost: 2.72, cost_china: null,
};

async function priced(location: string, row: Record<string, unknown> = AA_7003, family = 'sheet_metal') {
  const service = new MaterialResolutionService({ getClient: () => client([row]) } as never);
  const info = LOCATION_INFO[location]!;
  const warnings: string[] = [];
  const r = await service.resolveMaterialForFamily({
    accessToken: 't', grade: String(row.grade), family, materialCol: info.materialCol, rates: RATES, locCurrencyCode: info.code, location, warnings,
  });
  return { ...r, warnings };
}

describe('the material price of a quote: raw_materials USD per kg in the quote\'s currency', () => {
  it('India: AA 7003 is 2.72 USD/kg, 255.49 INR/kg (was 2.72 INR/kg)', async () => {
    const r = await priced('India');
    expect(r.materialSource).toBe('db');
    expect(r.materialCostPerKg).toBeCloseTo(2.72 * 93.93, 6);
  });

  it('the USA is unchanged: cost_usa as it stands', async () => {
    expect((await priced('USA')).materialCostPerKg).toBe(5.726);
  });

  it('a location without a price of its own falls back to India\'s, as before, now as the dollars it is (China: 2.72 USD, 18.13 CNY)', async () => {
    expect((await priced('China')).materialCostPerKg).toBeCloseTo(2.72 * 6.6665, 6);
  });

  it('the general cost column is USD too, where no location price is on file', async () => {
    const r = await priced('India', { ...AA_7003, cost_india: null, cost: 1.5 });
    expect(r.materialCostPerKg).toBeCloseTo(1.5 * 93.93, 6);
  });

  it('a machined part with no stock price on file prices every stock form at the material\'s own price, converted the same way', async () => {
    const r = await priced('India', AA_7003, 'milled');
    expect(Object.keys(r.stockFormPricesPerKg).length).toBeGreaterThan(0);
    for (const price of Object.values(r.stockFormPricesPerKg)) expect(price).toBeCloseTo(2.72 * 93.93, 6);
  });

  it('a material with no price is $0 and says so, never a converted zero', async () => {
    const r = await priced('India', { ...AA_7003, cost_usa: null, cost_india: null, cost: null });
    expect(r.materialCostPerKg).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/no verified cost/);
  });
});

describe('the sheet-metal scrap price: 30% of cost_india, in the quote\'s currency', () => {
  const scrap = (rows: Array<Record<string, unknown>>, currency: string) => {
    const service = Object.create(BomItemCostingService.prototype) as { sheetScrapPricePerKg: (g: string | null, c: string, r: RateSnapshot) => Promise<number>; databaseService: unknown };
    service.databaseService = { getUserClient: () => client(rows) };
    return service.sheetScrapPricePerKg('Generic Aluminum, AA 7003', currency, RATES);
  };

  it('India: 0.816 USD/kg, 76.65 INR/kg (was 0.816 INR/kg)', async () => {
    expect(await scrap([{ cost_india: 2.72 }], 'INR')).toBeCloseTo(0.3 * 2.72 * 93.93, 6);
  });

  it('the USA is unchanged: 30% of cost_india as it stands', async () => {
    expect(await scrap([{ cost_india: 2.72 }], 'USD')).toBeCloseTo(0.816, 9);
  });

  it('no India price, or no grade: no credit', async () => {
    expect(await scrap([{ cost_india: null }], 'INR')).toBe(0);
    expect(await scrap([], 'INR')).toBe(0);
  });
});
