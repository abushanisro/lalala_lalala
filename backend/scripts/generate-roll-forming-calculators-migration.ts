/**
 * Writes migration 1113 (the Sheet Metal Roll Forming calculators) from the calculator spec
 * (src/modules/bom-items/costing/roll-forming/calculators/roll-forming-calculators.json). Re-run after editing the spec, until the migration
 * is applied anywhere; after that a changed calculator ships in a new migration:
 *   npx ts-node --transpile-only scripts/generate-roll-forming-calculators-migration.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { buildRollFormingCalculatorsMigrationSql, ROLL_FORMING_CALCULATORS_MIGRATION } from '../src/modules/bom-items/costing/roll-forming/calculators/roll-forming-calculators-migration';

const OUT = join(__dirname, `../migrations/${ROLL_FORMING_CALCULATORS_MIGRATION}_roll_forming_calculators.sql`);
writeFileSync(OUT, buildRollFormingCalculatorsMigrationSql());
console.log(`wrote ${OUT}`);
