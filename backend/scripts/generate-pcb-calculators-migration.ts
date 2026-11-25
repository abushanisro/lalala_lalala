/**
 * Writes migrations 1132 (the PCB fabrication calculators) and 1134 (the PCB assembly calculators) from the calculator spec
 * (src/modules/bom-items/costing/pcb/calculators/pcb-calculators.json). A calculator in use is changed by a new migration, marked on its
 * spec entry; an applied migration regenerates byte-identical:
 *   npx ts-node --transpile-only scripts/generate-pcb-calculators-migration.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  buildPcbAssemblyCalculatorsMigrationSql, buildPcbCalculatorsMigrationSql, PCB_ASSEMBLY_CALCULATORS_MIGRATION, PCB_CALCULATORS_MIGRATION,
} from '../src/modules/bom-items/costing/pcb/calculators/pcb-calculators-migration';

for (const [number, name, sql] of [
  [PCB_CALCULATORS_MIGRATION, 'pcb_calculators', buildPcbCalculatorsMigrationSql()],
  [PCB_ASSEMBLY_CALCULATORS_MIGRATION, 'pcba_assembly_calculators', buildPcbAssemblyCalculatorsMigrationSql()],
] as const) {
  const out = join(__dirname, `../migrations/${number}_${name}.sql`);
  writeFileSync(out, sql);
  console.log(`wrote ${out}`);
}
