/**
 * Writes migration 1116 (the Stock Machining calculators) from the calculator spec
 * (src/modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators.json). Re-run after editing the spec, until the
 * migration is applied anywhere; after that a changed calculator ships in a new migration:
 *   npx ts-node --transpile-only scripts/generate-stock-machining-calculators-migration.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';

import { buildStockMachiningCalculatorsMigrationSql, STOCK_MACHINING_CALCULATORS_MIGRATION } from '../src/modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators-migration';

const OUT = join(__dirname, `../migrations/${STOCK_MACHINING_CALCULATORS_MIGRATION}_stock_machining_calculators.sql`);
writeFileSync(OUT, buildStockMachiningCalculatorsMigrationSql());
console.log(`wrote ${OUT}`);
