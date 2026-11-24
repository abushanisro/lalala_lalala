import { buildDomainCalculatorsMigrationSql } from '../../shared/calculators/domain-calculators-migration';
import { loadPcbCalculatorSpec } from './pcb-calculator-spec';

export const PCB_CALCULATORS_MIGRATION = 1132;

/** The SQL of migrations/1132_pcb_calculators.sql, built from the spec. */
export function buildPcbCalculatorsMigrationSql(): string {
  return buildDomainCalculatorsMigrationSql(loadPcbCalculatorSpec(), {
    number: PCB_CALCULATORS_MIGRATION,
    title: 'PCB calculators -- bare-board fabrication (imaging, lamination, drilling, plating, solder mask, legend, finish, profile, test) as real database calculators.',
    generator: 'scripts/generate-pcb-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/pcb/calculators/pcb-calculators.json',
    rootCause: [
      'PCB was staged (reference data 2026-PCB: 108 variables, the stack-up tables, the sourced consumables, process times and yields; 104 USA',
      'machines and their India twins, 13 laminates) but had no cost engine: its catalog processes had no calculator, and a part whose Process',
      'is PCB was not costed. These are the calculators of its fabrication steps: each catalog process times one board from the memory/PCBA',
      'variables and its machine\'s own specs; the board material, a core built from the reference, the drilling consumables, the solder mask, a',
      'plated metal, a test fixture and the fabrication yield are helpers the engine runs per board, which no operation maps to.',
    ].join('\n'),
  });
}
