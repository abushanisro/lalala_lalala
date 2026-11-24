/**
 * Writes migration 1132 (the PCB calculators) from the calculator spec (src/modules/bom-items/costing/pcb/calculators/pcb-calculators.json).
 * Re-run after editing the spec, until the migration is applied anywhere; after that a changed calculator ships in a new migration:
 *   npx ts-node --transpile-only scripts/generate-pcb-calculators-migration.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { buildPcbCalculatorsMigrationSql, PCB_CALCULATORS_MIGRATION } from '../src/modules/bom-items/costing/pcb/calculators/pcb-calculators-migration';

const OUT = join(__dirname, `../migrations/${PCB_CALCULATORS_MIGRATION}_pcb_calculators.sql`);
writeFileSync(OUT, buildPcbCalculatorsMigrationSql());
console.log(`wrote ${OUT}`);
