// The tables a calculator input's eye opens that are not a staged reference domain (served-reference-tables.ts) are served by the same
// GET /processes/reference-lookup as a staged table: each file of the plastic-molding reference package by name (never a path), and the
// costing tables of the database through the caller's own client.
import { NotFoundException } from '@nestjs/common';
import { ProcessesService } from '../../../modules/processes/processes.service';
import {
  COSTING_TABLES_DOMAIN, PLASTIC_REFERENCE_PACKAGE_DOMAIN, PLASTIC_REFERENCE_PACKAGE_FILES, electricityRef, referencePackageRef,
} from '../../../modules/bom-items/costing/shared/served-reference-tables';
import { electricityUsd } from '../../../modules/bom-items/costing/shared/location-electricity';

const USA = { location: 'USA', price_per_kwh: 0.0851, currency: 'USD', basis: 'U.S. EIA Electric Power Monthly, Table 5.3', source_url: null, retrieved_on: '2026-11-13' };

function service(rows: Record<string, unknown>[] = [USA]) {
  const read: string[] = [];
  const client = { from: (table: string) => { read.push(table); return { select: () => ({ limit: async () => ({ data: rows, error: null }) }) }; } };
  const db = { getClient: () => client, getPrivilegedClient: () => client };
  return { svc: new ProcessesService(db as never, {} as never), read };
}

describe('served reference tables', () => {
  it('serves every file of the plastic reference package by name, with its rows and columns', async () => {
    const { svc } = service();
    for (const file of PLASTIC_REFERENCE_PACKAGE_FILES) {
      const t = await svc.getReferenceLookup(PLASTIC_REFERENCE_PACKAGE_DOMAIN, file, 'token');
      expect(t.key).toBe(file);
      expect(t.rows.length).toBeGreaterThan(0);
      expect(t.columns).toEqual(Object.keys(t.rows[0]!));
    }
  });

  it('serves no other file and no path', async () => {
    const { svc } = service();
    for (const key of ['unresolved-costing-gaps.csv', '../../../../../../../package.json', 'im-reference.ts']) {
      await expect(svc.getReferenceLookup(PLASTIC_REFERENCE_PACKAGE_DOMAIN, key, 'token')).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('serves location_electricity_prices through the caller\'s client, and no other table', async () => {
    const { svc, read } = service();
    const t = await svc.getReferenceLookup(COSTING_TABLES_DOMAIN, 'location_electricity_prices', 'token');
    expect(t.rows).toEqual([USA]);
    expect(t.columns).toContain('price_per_kwh');
    expect(read).toEqual(['location_electricity_prices']);
    await expect(svc.getReferenceLookup(COSTING_TABLES_DOMAIN, 'mhr_records', 'token')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a reference-package value opens its file with its row; an electricity price opens its location\'s row, or the conversion to USD', () => {
    expect(referencePackageRef('gate-sizing-reference.csv', 'n', { material_family: 'POM / PC / PP' })).toEqual({
      kind: 'lookup', domain: PLASTIC_REFERENCE_PACKAGE_DOMAIN, table: 'gate-sizing-reference.csv', column: 'n', row: { material_family: 'POM / PC / PP' },
    });
    const usd = electricityUsd({ pricePerKwh: 0.0851, currency: 'USD', basis: 'EIA', location: 'USA' }, 'USA', () => null);
    expect(usd?.ref).toEqual(electricityRef('USA'));
    const eur = electricityUsd({ pricePerKwh: 0.175, currency: 'EUR', basis: 'HR Rates export', location: 'France' }, 'France', (v) => v * 1.1);
    expect(eur?.usdPerKwh).toBeCloseTo(0.1925, 9);
    expect(eur?.ref).toMatchObject({ kind: 'calculation', name: 'France electricity price in USD' });
    const steps = (eur!.ref as { steps: { ref?: unknown; value: unknown }[] }).steps;
    expect(steps[0]!.ref).toEqual(electricityRef('France'));
    expect(steps.at(-1)!.value).toBeCloseTo(0.1925, 6);
  });
});
