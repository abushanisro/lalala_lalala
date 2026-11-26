// The location's sourced electricity price (location_electricity_prices, migration 1004), read once for every process that charges energy.
import type { DbClient } from '../../../../common/db/postgrest-client';
import type { SourceRef } from '../../dto/cost-breakdown.dto';
import { electricityRef } from './served-reference-tables';

export interface LocationElectricity {
  pricePerKwh: number; currency: string; basis: string;
  /** The row's location (location_electricity_prices.location): the row the price's eye outlines. Absent on a price not read from the table. */
  location?: string;
}

/** The location's electricity price; null when it has none or it cannot be read. */
export async function loadLocationElectricity(client: DbClient, location: string): Promise<LocationElectricity | null> {
  const { data, error } = await client.from('location_electricity_prices').select('price_per_kwh, currency, basis').eq('location', location).maybeSingle();
  if (error || !data) return null;
  const row = data as { price_per_kwh: number | string; currency: string; basis: string };
  return { pricePerKwh: Number(row.price_per_kwh), currency: row.currency, basis: row.basis, location };
}

const p4 = (n: number) => String(Math.round(n * 10000) / 10000);

/**
 * The price in USD per kWh with where it came from, or null when the location has none or its currency has no rate to USD. Its ref is the
 * location's row of location_electricity_prices; a price in another currency is that row converted to USD, shown as the conversion.
 */
export function electricityUsd(
  row: LocationElectricity | null | undefined, location: string | undefined, toUsd: (value: number, currency: string) => number | null,
): { usdPerKwh: number; source: string; ref?: SourceRef } | null {
  if (!row) return null;
  const usd = row.currency === 'USD' ? row.pricePerKwh : toUsd(row.pricePerKwh, row.currency);
  if (usd == null || !(usd > 0)) return null;
  const converted = row.currency === 'USD' ? '' : ` = ${p4(usd)} USD/kWh`;
  const source = `${location ?? 'location'} electricity price: ${p4(row.pricePerKwh)} ${row.currency}/kWh (${row.basis})${converted}`;
  const at = row.location ?? location;
  const tableRef = at ? electricityRef(at) : undefined;
  if (!tableRef) return { usdPerKwh: usd, source };
  if (row.currency === 'USD') return { usdPerKwh: usd, source, ref: tableRef };
  return {
    usdPerKwh: usd, source,
    ref: {
      kind: 'calculation', name: `${at} electricity price in USD`, evidence: null,
      steps: [
        { fieldName: 'Electricity price', displayLabel: `Electricity price (${row.currency}/kWh)`, kind: 'input', value: row.pricePerKwh, unit: `${row.currency}/kWh`, source: `location_electricity_prices: ${at} (${row.basis})`, ref: tableRef },
        { fieldName: 'Exchange rate', displayLabel: `Exchange rate (USD per ${row.currency})`, kind: 'input', value: Math.round((usd / row.pricePerKwh) * 1e6) / 1e6, unit: null, source: `The exchange rate in use, ${row.currency} to USD` },
        { fieldName: 'Electricity Price', displayLabel: 'Electricity Price (USD/kWh)', kind: 'calculated', value: Math.round(usd * 1e6) / 1e6, unit: 'USD/kWh', formula: '{Electricity price} * {Exchange rate}' },
      ],
    },
  };
}
