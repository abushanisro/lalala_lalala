/**
 * A machined part's material where the location's stock prices do not hold it (India holds 71 to 90 materials per stock form of the USA's
 * 105). It borrows the stock price of its closest material only when that material is of the same kind (the same grade, a variant, the
 * same material type). A material merely near in density is another metal: Brass CW617N borrowed Inconel 625's stock price (both 8440
 * kg/m³). With nothing of its kind priced as stock, the material is priced from its own raw_materials price at the location.
 */
import { LOCATION_INFO } from '../../../../modules/bom-items/costing/shared/core/default-rates.constants';
import { MaterialResolutionService } from '../../../../modules/bom-items/services/material-resolution.service';

import type { RateSnapshot } from '../../../../common/exchange-rate/exchange-rate.service';

const INR_PER_USD = 93.93;
const RATES: RateSnapshot = {
  convertOptional: (from, to) => (from === to ? 1 : from === 'USD' && to === 'INR' ? INR_PER_USD : from === 'INR' && to === 'USD' ? 1 / INR_PER_USD : null),
  convertStrict: (from, to) => {
    if (from === to) return 1;
    if (from === 'USD' && to === 'INR') return INR_PER_USD;
    if (from === 'INR' && to === 'USD') return 1 / INR_PER_USD;
    throw new Error(`No exchange rate on file for '${from}' → '${to}'`);
  },
  toUsd: (amount) => amount,
  has: (c) => c === 'USD' || c === 'INR',
  rates: () => ({ USD: 1, INR: 1 / INR_PER_USD }),
  organizationId: null,
};

// The general catalog's rows as the local database holds them (Ferrous & Non-Ferrous): the part's brass, with its own India price, and
// the Inconel and aluminium India prices stock of. India prices no brass as stock.
const BRASS = {
  id: 'brass', name: 'Brass, CW617N', grade: 'Generic Brass, CW617N', material_group: 'Ferrous & Non-Ferrous', material_type: 'Brass',
  density_kg_m3: 8440, cost_usa: 10.73, cost_india: 5.27, cost: 5.27,
};
const INCONEL = { grade: 'Generic Inconel 625', material_type: 'Inconel', density_kg_m3: 8440, cost_india: 30.1, material_group: 'Ferrous & Non-Ferrous' };
const AL_7020 = { grade: 'Generic Aluminum, ANSI 7020', material_type: 'Aluminum', density_kg_m3: 2770, cost_india: 2.9, material_group: 'Ferrous & Non-Ferrous' };
const STOCK = [
  { raw_material_name: 'Generic Inconel 625', stock_form: 'round_bar', location: 'India', price_per_kg: 31.5, currency_code: 'USD', source: 'csv' },
  { raw_material_name: 'Generic Aluminum, ANSI 7020', stock_form: 'round_bar', location: 'India', price_per_kg: 2.91, currency_code: 'USD', source: 'csv' },
];

/** A data API holding `part` (the grade's own row), the stock prices above, and the rows of the materials they price. */
function client(part: Record<string, unknown>) {
  return {
    from: (table: string) => {
      let data: unknown[] = [];
      let byGrade = false;
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'ilike', 'or', 'not', 'order', 'limit', 'range']) builder[m] = () => builder;
      builder.in = (column: string) => { byGrade = column === 'grade'; return builder; };
      builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (table === 'material_stock_prices') data = STOCK;
        else if (table === 'raw_materials') data = byGrade ? [INCONEL, AL_7020] : [part];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return builder;
    },
  };
}

async function machinedIn(location: string, part: Record<string, unknown>) {
  const service = new MaterialResolutionService({ getClient: () => client(part) } as never);
  const info = LOCATION_INFO[location];
  const warnings: string[] = [];
  const r = await service.resolveMaterialForFamily({
    accessToken: 't', grade: String(part.grade), family: 'milled', materialCol: info.materialCol, rates: RATES, locCurrencyCode: info.code, location,
    stockPriceForm: 'round_bar', warnings,
  });
  return { ...r, warnings };
}

describe('a machined material India prices no stock of', () => {
  it("a brass is priced at its own India price, not at the stock price of an Inconel as dense", async () => {
    const r = await machinedIn('India', BRASS);
    expect(r.materialCostPerKg).toBeCloseTo(5.27 * INR_PER_USD, 6);
    expect(r.stockFormPriceBorrowedFrom).toEqual({});
    expect(r.warnings.join(' ')).not.toMatch(/Inconel/);
    expect(r.warnings.join(' ')).toMatch(/No round bar stock price on file for "Generic Brass, CW617N" in India; priced from raw_materials/);
  });

  it('a material of a type India prices as stock borrows from it, named', async () => {
    const aluminium = { ...BRASS, id: 'al2024', name: 'Aluminum, ANSI 2024', grade: 'Generic Aluminum, ANSI 2024', material_type: 'Aluminum', density_kg_m3: 2770, cost_india: null, cost: null };
    const r = await machinedIn('India', aluminium);
    expect(r.materialCostPerKg).toBeCloseTo(2.91 * INR_PER_USD, 6);
    expect(r.stockFormPriceBorrowedFrom.round_bar).toBe('Generic Aluminum, ANSI 7020');
  });

  it('with nothing of its kind priced as stock and no price of its own, borrows nothing: a brass is not an Inconel', async () => {
    const r = await machinedIn('India', { ...BRASS, cost_india: null, cost: null });
    expect(r.stockFormPriceBorrowedFrom).toEqual({});
    expect(r.warnings.join(' ')).not.toMatch(/Inconel/);
  });
});
