/**
 * Writes migrations 1116 (the Stock Machining calculators) and 1119 (the perimeter cut of Perimeter Milling with Drop-off) from the
 * calculator spec (src/modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators.json). A migration that is applied
 * anywhere never changes: a calculator added or changed after it ships in a new migration, marked with that migration in the spec.
 *   npx ts-node --transpile-only scripts/generate-stock-machining-calculators-migration.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';

import {
  buildStockMachiningCalculatorsMigrationSql, buildStockMachiningPerimeterCutMigrationSql, STOCK_MACHINING_CALCULATORS_MIGRATION, STOCK_MACHINING_PERIMETER_CUT_MIGRATION,
} from '../src/modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators-migration';

const OUT = join(__dirname, `../migrations/${STOCK_MACHINING_CALCULATORS_MIGRATION}_stock_machining_calculators.sql`);
writeFileSync(OUT, buildStockMachiningCalculatorsMigrationSql());
console.log(`wrote ${OUT}`);

const PERIMETER = join(__dirname, `../migrations/${STOCK_MACHINING_PERIMETER_CUT_MIGRATION}_stock_machining_perimeter_cut.sql`);
writeFileSync(PERIMETER, buildStockMachiningPerimeterCutMigrationSql());
console.log(`wrote ${PERIMETER}`);
