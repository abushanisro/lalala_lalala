import { loadRollFormingCalculatorSpec } from './roll-forming-calculator-spec';
import { buildDomainCalculatorsMigrationSql } from '../../shared/calculators/domain-calculators-migration';

export const ROLL_FORMING_CALCULATORS_MIGRATION = 1113;

/** The SQL of migrations/1113_roll_forming_calculators.sql, built from the spec. */
export function buildRollFormingCalculatorsMigrationSql(): string {
  return buildDomainCalculatorsMigrationSql(loadRollFormingCalculatorSpec(), {
    number: ROLL_FORMING_CALCULATORS_MIGRATION,
    title: 'Sheet Metal Roll Forming calculators -- the coil line\'s machines, the line speed, its stoppages, the strip and the tooling as real database calculators.',
    generator: 'scripts/generate-roll-forming-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/roll-forming/calculators/roll-forming-calculators.json',
    rootCause: [
      'Sheet Metal Roll Forming was staged (reference data 2026-RollForm: 126 variables, 19 lookup tables; 125 HR Rates machines, migrations',
      '862 and 1112) but its ten catalog processes had no calculator, and a part whose Process is Sheet Metal Roll Forming was not costed. These',
      'are the calculators of its coil line: Coil Material Stock, Uncoiler, Coil Flattener, Punch Press, Roll Forming Mill, the four integrated',
      'welding processes and the Cut-Off Press compute the catalog processes (each machine busy for the part\'s run at the line speed, plus the',
      'line\'s stoppages); the roll stations, the line speed, the coil change, the die re-sharpening, the strip, the material, the press force,',
      'the roll tooling and the press dies are helpers the engine runs per part, which no operation maps to. The data has no cycle, station or',
      'tooling formula: those rules are the engine\'s own, agreed with the user 2026-11-22. The calculators are named "Roll Forming - ..." (a',
      'user\'s own calculator is named "Sheet Metal - Roll Forming").',
    ].join('\n'),
  });
}
