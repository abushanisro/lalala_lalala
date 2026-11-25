/**
 * Writes migrations/804_machining_calculators.sql from the machining
 * calculator spec (src/modules/bom-items/costing/machining/calculators/
 * machining-calculators.json). Re-run after editing the spec:
 *   npx ts-node --transpile-only scripts/generate-machining-calculators-migration.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { buildMachiningCalculatorMigrationSql, buildMachiningCalculatorsMigrationSql } from '../src/modules/bom-items/costing/machining/calculators/machining-calculators-migration';

const OUT = join(__dirname, '../migrations/804_machining_calculators.sql');
writeFileSync(OUT, buildMachiningCalculatorsMigrationSql());
console.log(`wrote ${OUT}`);

// Calculators added after 804, each in the migration the spec names.
const LATER: Record<number, string> = {
  1027: '1027_machining_milling_calculator.sql',
  1028: '1028_machining_calculators_missing_after_804.sql',
  1029: '1029_machining_inspection_from_reference.sql',
  1030: '1030_machining_calculators_batch_2.sql',
  1031: '1031_machining_mill_operation_calculators.sql',
  1032: '1032_machining_calculators_batch_3.sql',
  1035: '1035_machining_countersinking_calculator.sql',
  1037: '1037_machining_part_setup_calculator.sql',
  1038: '1038_machining_finishing_calculators.sql',
  1118: '1118_machining_obround_slot_milling_calculator.sql',
  1128: '1128_machining_turning_follows_the_workbook.sql',
  1138: '1138_machining_turning_family_workbook.sql',
  1139: '1139_machining_hole_making_workbook.sql',
  1140: '1140_machining_milling_named_ops_workbook.sql',
  1142: '1142_machining_milling_rapids_tool_changes.sql',
  1146: '1146_machining_inspection_gauge_and_xrf.sql',
  1149: '1149_machining_stock_prep_mill_moves_from_data.sql',
  1150: '1150_machining_finishing_spindle_from_machine.sql',
  1151: '1151_machining_inspection_workbook.sql',
  1152: '1152_machining_edges_and_spots_workbook.sql',
};
for (const [n, file] of Object.entries(LATER)) {
  writeFileSync(join(__dirname, '../migrations', file), buildMachiningCalculatorMigrationSql(Number(n)));
  console.log(`wrote ${file}`);
}
