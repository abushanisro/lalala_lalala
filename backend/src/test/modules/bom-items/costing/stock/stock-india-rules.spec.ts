// India's stock rules (migration 1143, from the machining calculator workbook's Material calc sheets), staged beside memory/Stock Maching's
// USA rows: a location's own row replaces the reference's (sand-reference.service.ts rowsForRegion), every other rule stays the reference's.
// The India rows are read from the migration itself, so the test and the data cannot drift apart.
import { readFileSync } from 'fs';
import { join } from 'path';

import { stockLookups, stockVariables } from './stock-test-data';
import { rowsForRegion } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference.service';
import { resolveSandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { BAR_END_REMNANT_MM } from '../../../../../modules/bom-items/costing/stock/stock-research';
import { chooseStockMachining } from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost.service';

const MIGRATION = readFileSync(join(__dirname, '../../../../../../migrations/1143_stock_machining_india_rules.sql'), 'utf8');
const INDIA_ROWS = [...MIGRATION.matchAll(/\('variable', 'India', \$str\$2026-Stock-Machining\$str\$, \$str\$(\w+)\$str\$, \$str\$([^$]+)\$str\$, (?:\$str\$(\w+)\$str\$|NULL)/g)]
  .map((m) => ({ key: m[1]!, value: m[2]!, unit_type: m[3] ?? null, source_region: 'India' }));
const ALL = [...stockVariables().map((v) => ({ ...v, source_region: 'USA' })), ...INDIA_ROWS];
const referenceFor = (region: string | null) => {
  const ref = resolveSandReference({ variables: rowsForRegion(ALL, region), lookups: stockLookups() });
  return { ref, stock: stockReference(ref).reference! };
};

describe('migration 1143 stages India\'s rules from the workbook', () => {
  it('seven rows under source_region India', () => {
    expect(Object.fromEntries(INDIA_ROWS.map((r) => [r.key, r.value]))).toEqual({
      standardStockLength: '3000', stockBarEndRemnant: '5', bandSawKerf: '2', standardPlateLength: '3000', standardPlateWidth: '1000',
      enableScrapMaterialCredit: 'true', scrapRecoveryPercent: '95',
    });
  });
});

describe('a location reads its own row, else the reference\'s', () => {
  it('India\'s bar length replaces the reference\'s; a key India does not state is the reference\'s; with no location, the reference\'s', () => {
    const india = new Map(rowsForRegion(ALL, 'India').map((r) => [r.key, r]));
    expect(india.get('standardStockLength')).toMatchObject({ value: '3000', source_region: 'India' });
    expect(india.get('percentStockAllowance')).toMatchObject({ source_region: 'USA' });
    expect(new Map(rowsForRegion(ALL, null).map((r) => [r.key, r])).get('standardStockLength')).toMatchObject({ value: '6096', source_region: 'USA' });
    expect(new Map(rowsForRegion(ALL, 'USA').map((r) => [r.key, r])).get('bandSawKerf')).toMatchObject({ value: '0.889' });
  });
});

describe('the stock rules for each location', () => {
  it('India: a 3000 mm bar, a 3000 x 1000 plate, a 2 mm cut, a 5 mm bar end, the scrap credited at 95 % recovery', () => {
    const { stock } = referenceFor('India');
    expect(stock).toMatchObject({ barLengthMm: 3000, kerfMm: 2, scrapCredit: true, barEndMm: 5, scrapRecoveryPercent: 95 });
    expect(stock.plate).toMatchObject({ lengthMm: 3000, widthMm: 1000 });
  });

  it('USA: the reference as it was, with no bar end or scrap recovery of its own', () => {
    const { stock } = referenceFor('USA');
    expect(stock).toMatchObject({ barLengthMm: 6096, kerfMm: 0.889, scrapCredit: false, barEndMm: null, scrapRecoveryPercent: null });
    expect(stock.plate).toMatchObject({ lengthMm: 914.4, widthMm: 457.2 });
  });
});

describe('the stock chosen for India', () => {
  // The Lead Screw side shaft, Ø14 x 32.
  const SHAFT = {
    machiningStock: undefined, family: 'mill_turn' as const, box: { length: 32, width: 14, height: 14 }, volumeMm3: 2646, turned: { diameterMm: 14, lengthMm: 32 },
  };
  const choose = (location: string) => chooseStockMachining({ ...referenceFor(location), location, part: SHAFT, overrides: {} }).choice!;

  it('yields its parts from a 3000 mm bar less the 5 mm bar end, 2 mm apart, as the workbook\'s Rod sheet does', () => {
    const india = choose('India');
    expect(india.remnant).toEqual({ mm: 5, source: 'Stock Machining variable stockBarEndRemnant for India (mm)' });
    expect(india.scrapCredit).toBe(true);
    expect(india.scrapRecovery).toEqual({ percent: 95, source: 'Stock Machining variable scrapRecoveryPercent for India (%)' });
    const bar = india.selection.saw.chosen!;
    expect(bar.stock.lengthMm).toBe(3000);
    expect(bar.cutWidthMm).toBe(2);
    // The workbook: parts = (3000 - 5) / (piece length + 2), whole parts.
    expect(bar.stock.partsPerStock).toBe(Math.floor((3000 - 5) / (bar.blank.lengthMm + 2)));
  });

  it('USA keeps the researched bar end and credits the whole scrap weight when the credit is turned on', () => {
    const usa = choose('USA');
    expect(usa.remnant.mm).toBe(BAR_END_REMNANT_MM);
    expect(usa.scrapCredit).toBe(false);
    expect(usa.scrapRecovery.percent).toBe(100);
  });
});
