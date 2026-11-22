import { loadStockMachiningCalculatorSpec } from './stock-machining-calculator-spec';
import { buildDomainCalculatorsMigrationSql } from '../../shared/calculators/domain-calculators-migration';

export const STOCK_MACHINING_CALCULATORS_MIGRATION = 1116;

/** The SQL of migrations/1116_stock_machining_calculators.sql, built from the spec. */
export function buildStockMachiningCalculatorsMigrationSql(): string {
  return buildDomainCalculatorsMigrationSql(loadStockMachiningCalculatorSpec(), {
    number: STOCK_MACHINING_CALCULATORS_MIGRATION,
    title: 'Stock Machining calculators -- the stock a machined part is cut from, its yield and the band saw as real database calculators.',
    generator: 'scripts/generate-stock-machining-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators.json',
    rootCause: [
      'Stock Machining was staged (reference data 2026-Stock-Machining: 53 variables and its lookup tables, migrations 816 and 1114; 13 band',
      'saws and the Material Stock machine in HR Rates, migrations 815 and 1114; the machine classes of its two catalog mappings, migration 1115) but its two catalog processes had no calculator, and a part',
      'whose Process is Stock Machining was not costed. These are the calculators of its stock front end: Band Saw computes the catalog process',
      '(the stock cut to pieces: the area cut at the material\'s cutting rate, the feed, the load and the unload); Material Stock, the stock as',
      'supplied, takes no machine time. The stock\'s size, the bar and plate yield and the scrap credit are helpers the engine runs per part,',
      'which no operation maps to. The data states the allowance, snapping and plate rules as variables and has no yield or saw cycle formula:',
      'those rules are the engine\'s own, agreed with the user 2026-11-22. The machining of the part itself is the Machining group\'s.',
    ].join('\n'),
  });
}
