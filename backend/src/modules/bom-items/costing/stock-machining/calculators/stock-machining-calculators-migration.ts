import { loadStockMachiningCalculatorSpec } from './stock-machining-calculator-spec';
import { buildDomainCalculatorsMigrationSql } from '../../shared/calculators/domain-calculators-migration';

export const STOCK_MACHINING_CALCULATORS_MIGRATION = 1116;

/** The SQL of migrations/1116_stock_machining_calculators.sql, built from the spec. */
export function buildStockMachiningCalculatorsMigrationSql(): string {
  // The calculators 1116 created, as it created them: an entry a later migration replaced is still generated here, and a later one is not.
  return buildDomainCalculatorsMigrationSql(loadStockMachiningCalculatorSpec({ includeSuperseded: true }), {
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
  }, (c) => c.migration == null);
}

export const STOCK_MACHINING_PERIMETER_CUT_MIGRATION = 1119;

/** The SQL of migrations/1119_stock_machining_perimeter_cut.sql: the cut round a part's outline of Perimeter Milling with Drop-off. */
export function buildStockMachiningPerimeterCutMigrationSql(): string {
  return buildDomainCalculatorsMigrationSql(loadStockMachiningCalculatorSpec(), {
    number: STOCK_MACHINING_PERIMETER_CUT_MIGRATION,
    title: 'Stock Machining - Perimeter Cut -- the cut round a plate part\'s outline, for the roughing technique Perimeter Milling with Drop-off.',
    generator: 'scripts/generate-stock-machining-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators.json',
    rootCause: [
      'A part cut from plate was costed one way only: a rectangular blank sawn out of the plate, and everything round the part milled away',
      '(the data\'s default roughing technique, All Bulk Milling). The data names two more techniques (defaultRoughingTechnique), which were',
      'not costed. With Perimeter Milling with Drop-off the plate goes on the mill whole and the mill cuts round each part\'s outline through',
      'the plate\'s thickness. This is the calculator of that cut: a slot as wide as the cutter, taken in passes by the slotting rule of',
      'Machining - Obround Slot Milling (migration 1118), each pass following the outline at the cutter\'s feed rate. It is a helper: its',
      'time is one more operation (Perimeter Milling) of the mill\'s own line, so no catalog operation maps to it. The data has no formula',
      'for the cut: this rule is the engine\'s own, agreed with the user 2026-11-22. Plate Cutting with Drop-off needs no calculator of its',
      'own: its cut is priced by the Sheet Metal cutting calculators and engines.',
    ].join('\n'),
  }, (c) => c.migration === STOCK_MACHINING_PERIMETER_CUT_MIGRATION);
}

export const STOCK_MACHINING_SCRAP_RECOVERY_MIGRATION = 1144;

/** The SQL of migrations/1144_stock_machining_scrap_recovery.sql: the scrap credit, version 2, of which only the recovered scrap is sold. */
export function buildStockMachiningScrapRecoveryMigrationSql(): string {
  return buildDomainCalculatorsMigrationSql(loadStockMachiningCalculatorSpec(), {
    number: STOCK_MACHINING_SCRAP_RECOVERY_MIGRATION,
    title: 'Stock Machining - Scrap Credit, version 2 -- only the recovered share of the scrap is sold.',
    generator: 'scripts/generate-stock-machining-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators.json',
    rootCause: [
      'Version 1 credited the whole scrap weight: the stock bought per part less the part, at its price and the material\'s Scrap Cost Percent.',
      'The machining calculator workbook (memory/Machining - Calculator Database (1).xlsx, its four Material calc sheets) credits only the',
      'scrap recovered, 95 % of it, for India. Version 2 multiplies by the location\'s scrapRecoveryPercent (migration 1143); a location with',
      'none staged keeps the whole scrap weight, as before (the project owner\'s decision of 2026-11-24: India material rules and scrap recovery).',
    ].join('\n'),
  }, (c) => c.migration === STOCK_MACHINING_SCRAP_RECOVERY_MIGRATION);
}
