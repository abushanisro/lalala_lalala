import { buildDomainCalculatorsMigrationSql } from '../../shared/calculators/domain-calculators-migration';
import { loadPcbCalculatorSpec } from './pcb-calculator-spec';

export const PCB_CALCULATORS_MIGRATION = 1132;
export const PCB_ASSEMBLY_CALCULATORS_MIGRATION = 1134;

/** The SQL of migrations/1132_pcb_calculators.sql, built from the spec: the calculators 1132 created (a later one is marked with its migration). */
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
  }, (c) => c.migration == null);
}

/** The SQL of migrations/1134_pcba_assembly_calculators.sql: the PCB assembly calculators. */
export function buildPcbAssemblyCalculatorsMigrationSql(): string {
  return buildDomainCalculatorsMigrationSql(loadPcbCalculatorSpec(), {
    number: PCB_ASSEMBLY_CALCULATORS_MIGRATION,
    title: 'PCB assembly calculators -- the SMT line (print, SPI, placement, reflow, AOI), through-hole insertion and soldering, test and depanel.',
    generator: 'scripts/generate-pcb-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/pcb/calculators/pcb-calculators.json',
    rootCause: [
      'A board with components was priced as a bare board: the PCB catalog had no assembly process and no calculator for one. Migration 1133',
      'seeded the SMT line, through-hole and test machines (USA, India) and the sourced assembly reference (memory/PCBA/Assembly), and the',
      'catalog\'s assembly processes. These are their calculators: each times one board from the board files\' counts (placements, joints,',
      'nets, the array) and the sourced rates; the line changeover, the line\'s wait on its slowest machine, the solder paste and the ICT',
      'fixture are helpers the engine runs per board, which no operation maps to.',
    ].join('\n'),
  }, (c) => c.migration === PCB_ASSEMBLY_CALCULATORS_MIGRATION);
}
