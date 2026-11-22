// The real memory/Stock Maching data as the staged rows the engine reads (migrations 816 and 1114, source version 2026-Stock-Machining), for
// the stock tests: its variables, its band saw tables and plate spacings, and the whole preferred stock sizes and parting ring tables, each
// with the keys migration 1114 stages it under. Everything is read from memory/ (CI checks it out case-sensitively: "Stock Maching",
// "lookup", "Multi-Spindle Maching").
import { join } from 'path';

import { sandMachineFromRow, type SandMachine } from '../../../../../modules/bom-items/costing/casting/sand/sand-machines';
import { resolveSandReference, type SandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';

import type { StockMachiningMaterial } from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-route';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv, specKey } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as {
  readCsv: (p: string) => { columns: string[]; rows: Record<string, unknown>[] };
  specKey: (h: string) => string;
};

const MEMORY = join(__dirname, '../../../../../../../memory');
const DIR = join(MEMORY, 'Stock Maching');
const rows = (path: string) => readCsv(path).rows;

export const stockVariables = () => rows(join(DIR, 'variables.csv'))
  .map((r) => ({ key: String(r['Variable Name']), value: r['String Value'] == null ? null : String(r['String Value']), unit_type: (r['Unit Type Name'] as string) || null }));

const lookups = [
  ...['bandSawCutting', 'bandSawHandling', 'tblPartSpacing'].map((t) => ({ key: t, raw: { rows: rows(join(DIR, 'lookup', `${t}.csv`)) } })),
  // The whole table (memory/Stock Maching holds a cut-down export of it), with the keys it is staged under.
  { key: 'tblPreferredSizes', raw: { rows: rows(join(MEMORY, 'Multi-Spindle Maching/lookup/tblPreferredSizes.csv')).map((r) => ({ sizeMm: r.sizeMm, unitSystem: r.unitSystem, comment: r.comment })) } },
  { key: 'tblPartingRingWidth', raw: { rows: rows(join(DIR, 'lookup/tblPartingRingWidth.csv')).map((r) => ({ diameterMm: r['Diameter (mm)'], ringWidthMm: r['Ring Width (mm)'] })) } },
];
export const stockLookups = () => lookups;

/** The staged Stock Machining reference, optionally with some variables replaced. */
export function realStockMachiningReference(replace: Record<string, string> = {}): SandReference {
  return resolveSandReference({ variables: stockVariables().map((v) => (v.key in replace ? { ...v, value: replace[v.key] } : v)), lookups });
}

const cents = (v: unknown) => Math.round(Number(String(v).replace(/[$\s,]/g, '')) * 100) / 100;
/** The India labour of the saws' wage grade, 2 - Metal (the rate that grade's HR Rates rows carry). */
const INDIA_LABOUR = 1.65;

/**
 * The 13 band saws of a location as HR Rates holds them (migration 815: class band_saw, each file column that is not a rate in specs): the
 * reference file's rates in the USA, the India export's overheads and the India labour of the grade in India.
 */
export function bandSaws(location: 'USA' | 'India' = 'USA'): SandMachine[] {
  const india = new Map(rows(join(MEMORY, 'Countries data/India_XML_Data_.csv')).filter((r) => r.Commodity === 'Stock Machining' && r['Machine Type'] === 'Band Saw').map((r) => [String(r.name), r]));
  return rows(join(DIR, 'Machine/machines_band_saw.csv')).map((r, i) => {
    const name = String(r.Name);
    const rate = location === 'USA'
      ? cents(r['Direct Overhead Rate (USD / hr)']) + cents(r['Indirect Overhead Rate (USD / hr)'])
      : cents(india.get(name)!.customWorkCenterDirectOverheadRate) + cents(india.get(name)!.customWorkCenterIndirectOverheadRate);
    return sandMachineFromRow({
      id: `band_saw-${location}-${i}`, machine_name: name, machine_class: 'band_saw', location, mhr_usd_per_hour: Math.round(rate * 100) / 100,
      usd_labor_rate_per_hr: location === 'USA' ? r['Labor Rate (USD / hr)'] : INDIA_LABOUR, operators: r['Number of Operators'], setup_time_hr: r['Setup Time (hr)'],
      machine_power_kw: r['Machine Power (kW)'],
      specs: Object.fromEntries(['Load+Unload Time (s)', 'Unload Time (s)', 'Axial Feed Rate (mm / s)', 'Max Cut Angle (deg)', 'Max Stock Diameter (mm)', 'Max Stock Height (mm)',
        'Max Stock Width (mm)', 'Is Preferred'].map((c) => [specKey(c), r[c]])),
    }, () => null);
  });
}

/** A material of memory/Stock Maching's materials, priced for a stock form (its file column), as the cost service resolves it. */
export function stockMaterial(name: string, priceColumn: string): StockMachiningMaterial {
  const r = rows(join(DIR, 'metirials/materials_band_saw.csv')).find((m) => m.Name === name);
  if (!r) throw new Error(`no Stock Machining material ${name}`);
  return {
    name, cutCode: Number(r['Cut Code']), densityKgM3: Number(r['Density (kg / m^3)']), pricePerKgUsd: Number(r[priceColumn]),
    priceSource: `material_stock_prices: ${name}`, scrapCostPercent: Number(r['Scrap Cost Percent (%)']),
  };
}

