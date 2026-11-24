// The machining workbook's tables as the turning engine is given them (memory/machining/workbook, staged by migration 1137), with
// a fixed rupee rate, so a spec times a cut on the workbook's own speeds and feeds.
import { join } from 'path';

import { WORKBOOK_TABLES } from '../../../../../modules/bom-items/costing/machining/lookup/workbook-cutting-data';
import type { MachiningWorkbookInput } from '../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as { readCsv: (path: string) => { rows: any[] } };

const DIR = join(__dirname, '../../../../../../../memory/machining/workbook');

/** The rupees in a dollar these specs convert the workbook's tool prices at. */
export const TEST_INR_PER_USD = 84;

export function workbookFixture(over: Partial<MachiningWorkbookInput> = {}): MachiningWorkbookInput {
  const tables = Object.fromEntries(WORKBOOK_TABLES.map((t) => [t, readCsv(join(DIR, `${t}.csv`)).rows]));
  return { tables, inrToLocal: 1 / TEST_INR_PER_USD, inrToUsd: 1 / TEST_INR_PER_USD, ...over };
}
