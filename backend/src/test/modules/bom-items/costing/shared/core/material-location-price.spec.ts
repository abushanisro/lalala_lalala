/**
 * raw_materials holds every location's price in USD per kg (material-location-price.ts), and the one rule turns it into the quote's
 * currency at the request's rates. The numbers are the local database's: Aluminum AA 7003 at 5.726 USD/kg in the USA and 2.72 in India,
 * and the reference USD rates of 2026-11-16 (93.93 INR, 6.6665 CNY, 0.90794 EUR per USD).
 */
import { RAW_MATERIAL_PRICE_CURRENCY, rawMaterialPricePerKg } from '../../../../../../modules/bom-items/costing/shared/core/material-location-price';

/** A snapshot as ExchangeRateService builds one: USD per unit of each currency, converted through it. */
function rates(usdPer: Record<string, number>) {
  const per = new Map(Object.entries({ USD: 1, ...usdPer }));
  return {
    convertStrict: (from: string, to: string) => {
      if (from === to) return 1;
      const f = per.get(from);
      const t = per.get(to);
      if (f == null || t == null) throw new Error(`No exchange rate on file for '${from}' → '${to}'`);
      return f / t;
    },
  };
}
const FX = rates({ INR: 1 / 93.93, CNY: 1 / 6.6665, EUR: 1 / 0.90794 });

describe('a raw_materials price is USD per kg, converted to the quote\'s currency', () => {
  it('the columns are USD', () => {
    expect(RAW_MATERIAL_PRICE_CURRENCY).toBe('USD');
  });

  it('India: cost_india 2.72 is 2.72 dollars, 255.49 rupees (it was read as 2.72 rupees, 0.029 USD)', () => {
    expect(rawMaterialPricePerKg(2.72, 'INR', FX)).toBeCloseTo(255.4896, 4);
    expect(rawMaterialPricePerKg('2.72', 'INR', FX)).toBeCloseTo(255.4896, 4);
  });

  it('the USA is unchanged: the same number, at a rate of exactly 1', () => {
    expect(rawMaterialPricePerKg(5.726, 'USD', FX)).toBe(5.726);
  });

  it('every other location converts the same way (China, Europe)', () => {
    expect(rawMaterialPricePerKg(2.96, 'CNY', FX)).toBeCloseTo(19.73284, 5);
    expect(rawMaterialPricePerKg(3.58, 'EUR', FX)).toBeCloseTo(3.2504252, 6);
  });

  it('no price is null, never a zero dressed as a price', () => {
    for (const v of [null, undefined, '', 0, '0', -1, 'n/a', Number.NaN]) expect(rawMaterialPricePerKg(v, 'INR', FX)).toBeNull();
  });

  it('a currency with no rate on file is refused, never assumed (no fixed rupee rate)', () => {
    expect(() => rawMaterialPricePerKg(2.72, 'MXN', FX)).toThrow(/No exchange rate/);
  });
});
