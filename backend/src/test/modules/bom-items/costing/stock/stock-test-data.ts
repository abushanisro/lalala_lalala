// The real memory/Stock Maching data as the staged rows the engine reads (migrations 816 and 1114, source version 2026-Stock-Machining), for
// the stock tests: its variables, its band saw tables and plate spacings, and the whole preferred stock sizes and parting ring tables, each
// with the keys migration 1114 stages it under. Everything is read from memory/ (CI checks it out case-sensitively: "Stock Maching",
// "lookup", "Multi-Spindle Maching").
import { join } from 'path';

import { resolveSandReference, type SandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as {
  readCsv: (p: string) => { columns: string[]; rows: Record<string, unknown>[] };
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
