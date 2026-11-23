import type { RateSnapshot } from '../../../../../common/exchange-rate/exchange-rate.service';

/**
 * The currency of every price raw_materials holds: the price at each Digital Factory location (cost_usa, cost_india, cost_china, ...,
 * LOCATION_INFO's materialCol) and the general `cost`. Each is the material's price at that location in US dollars per kg, whatever
 * the location's own currency: the reference data the catalog came from heads them "India Cost (USD)", "China Cost (USD)", ..., the
 * material import reads "Cost India (USD/kg)", migration 350 comments each column "USD/kg", and on the local database 510 of the 512
 * India prices are at most twice the USA price. Reading cost_india as rupees priced Aluminum AA 7003 in India at 0.029 USD/kg against
 * 5.726 in the USA.
 */
export const RAW_MATERIAL_PRICE_CURRENCY = 'USD';

/**
 * A raw_materials price (USD per kg) in the quote's currency, at the request's exchange-rate snapshot; null when the value is not a
 * positive price. The one place such a price becomes money: every reader converts here and none reads a location's column as that
 * location's currency.
 */
export function rawMaterialPricePerKg(usdPerKg: unknown, currencyCode: string, rates: Pick<RateSnapshot, 'convertStrict'>): number | null {
  const usd = Number(usdPerKg);
  return Number.isFinite(usd) && usd > 0 ? usd * rates.convertStrict(RAW_MATERIAL_PRICE_CURRENCY, currencyCode) : null;
}
