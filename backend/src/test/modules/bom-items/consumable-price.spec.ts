// resolveConsumablePrice (private, exercised via `as any` like bom-items.currency.spec.ts):
// a missing price is null (so the waterjet engine can warn), a failed query is an error,
// and the price is converted into the caller's costing currency — never a guessed location.
import { BomItemCostingService } from '../../../modules/bom-items/bom-item-costing.service';
import type { RateSnapshot } from '../../../common/exchange-rate/exchange-rate.service';

type Row = { data: { price_per_unit: number | null } | null; error: { message: string } | null };

function serviceReturning(rowsByLocation: Record<string, Row>) {
  const asked: string[] = [];
  const db = {
    getClient: () => ({
      from: () => {
        const filters: Record<string, string> = {};
        const q = {
          select: () => q,
          eq: (col: string, v: string) => { filters[col] = v; return q; },
          maybeSingle: async () => {
            asked.push(filters.location!);
            return rowsByLocation[filters.location!] ?? { data: null, error: null };
          },
        };
        return q;
      },
    }),
  };
  const deps = Array.from({ length: 16 }, () => ({}));
  const service = new (BomItemCostingService as any)({}, {}, {}, {}, {}, db, ...deps) as BomItemCostingService;
  return { service: service as any, asked };
}

const rates: RateSnapshot = {
  convertOptional: (from, to) => (from === to ? 1 : from === 'USD' && to === 'INR' ? 80 : null),
  convertStrict: (from, to) => {
    if (from === to) return 1;
    if (from === 'USD' && to === 'INR') return 80;
    throw new Error(`No exchange rate on file for '${from}' → '${to}'`);
  },
  toUsd: (amount) => amount,
  has: (c) => c === 'USD' || c === 'INR',
  rates: () => ({ USD: 1, INR: 1 / 80 }),
  organizationId: null,
};

describe('BomItemCostingService.resolveConsumablePrice', () => {
  it("converts the location's own USD price into the costing currency", async () => {
    const { service } = serviceReturning({ India: { data: { price_per_unit: 0.5 }, error: null } });
    await expect(service.resolveConsumablePrice('t', 'garnet_abrasive', 'India', 'INR', rates)).resolves.toBe(40);
  });

  it("falls back to the table's __default__ row, then returns null — not 0 — when there is none", async () => {
    const withDefault = serviceReturning({ __default__: { data: { price_per_unit: 1 }, error: null } });
    await expect(withDefault.service.resolveConsumablePrice('t', 'garnet_abrasive', 'Brazil', 'USD', rates)).resolves.toBe(1);
    expect(withDefault.asked).toEqual(['Brazil', '__default__']);

    const none = serviceReturning({});
    await expect(none.service.resolveConsumablePrice('t', 'garnet_abrasive', 'India', 'INR', rates)).resolves.toBeNull();
  });

  it('throws on a failed query instead of pricing the consumable at 0', async () => {
    const { service } = serviceReturning({ India: { data: null, error: { message: 'boom' } } });
    await expect(service.resolveConsumablePrice('t', 'garnet_abrasive', 'India', 'INR', rates)).rejects.toThrow('boom');
  });

  it('throws when the FX rate is missing instead of returning 0', async () => {
    const { service } = serviceReturning({ UK: { data: { price_per_unit: 1 }, error: null } });
    await expect(service.resolveConsumablePrice('t', 'garnet_abrasive', 'UK', 'GBP', rates)).rejects.toThrow('No exchange rate');
  });
});

// waterjetNozzleRate: the reference data states a nozzle's cost in USD. The engine adds the wear to lines that are in the
// quote's currency, so the rate is converted before it gets there; a rate that is not on file stays a reported gap.
describe('BomItemCostingService.waterjetNozzleRate', () => {
  function serviceWithNozzle(nozzle: { costPerHr: number; dataFound: boolean }) {
    const smLookup = { getWaterjetNozzleCostPerHr: async () => nozzle };
    const deps = Array.from({ length: 15 }, () => ({}));
    return new (BomItemCostingService as any)({}, {}, {}, {}, {}, {}, {}, {}, smLookup, ...deps) as any;
  }

  it("converts the nozzle's USD rate into the costing currency", async () => {
    const service = serviceWithNozzle({ costPerHr: 100 / 85, dataFound: true });
    await expect(service.waterjetNozzleRate('USD', rates)).resolves.toEqual({ costPerHr: 100 / 85, dataFound: true });
    const india = await service.waterjetNozzleRate('INR', rates);
    expect(india.dataFound).toBe(true);
    expect(india.costPerHr).toBeCloseTo((100 / 85) * 80, 6);
  });

  it('leaves a rate that is not on file as it is: no conversion, no charge', async () => {
    const service = serviceWithNozzle({ costPerHr: 0, dataFound: false });
    await expect(service.waterjetNozzleRate('INR', rates)).resolves.toEqual({ costPerHr: 0, dataFound: false });
    // no rate to convert, so a currency with no exchange rate is not an error here
    await expect(service.waterjetNozzleRate('GBP', rates)).resolves.toEqual({ costPerHr: 0, dataFound: false });
  });

  it('throws when the FX rate is missing instead of charging USD as if it were the local currency', async () => {
    const service = serviceWithNozzle({ costPerHr: 100 / 85, dataFound: true });
    await expect(service.waterjetNozzleRate('GBP', rates)).rejects.toThrow('No exchange rate');
  });
});
