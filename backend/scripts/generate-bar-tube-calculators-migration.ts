/**
 * Writes migrations 1091 (the bar and tube calculators) and 1117 (the saw cut, version 2) from the bar and tube calculator spec
 * (src/modules/bom-items/costing/bar-tube/calculators/bar-tube-calculators.json). A migration that is applied anywhere never changes: a
 * changed calculator ships in a new migration, and the entry it replaces stays in the spec so the earlier one regenerates as applied.
 *   npx ts-node --transpile-only scripts/generate-bar-tube-calculators-migration.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  BAR_TUBE_CALCULATORS_MIGRATION, BAR_TUBE_SAW_BUNDLE_MIGRATION, buildBarTubeCalculatorsMigrationSql, buildBarTubeSawBundleMigrationSql,
} from '../src/modules/bom-items/costing/bar-tube/calculators/bar-tube-calculators-migration';

const OUT = join(__dirname, `../migrations/${BAR_TUBE_CALCULATORS_MIGRATION}_bar_tube_calculators.sql`);
writeFileSync(OUT, buildBarTubeCalculatorsMigrationSql());
console.log(`wrote ${OUT}`);

const SAW = join(__dirname, `../migrations/${BAR_TUBE_SAW_BUNDLE_MIGRATION}_bar_tube_saw_bundle.sql`);
writeFileSync(SAW, buildBarTubeSawBundleMigrationSql());
console.log(`wrote ${SAW}`);
