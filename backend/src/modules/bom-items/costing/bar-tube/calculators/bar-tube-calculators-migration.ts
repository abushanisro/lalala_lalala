import { buildDomainCalculatorsMigrationSql } from '../../shared/calculators/domain-calculators-migration';
import { loadBarTubeCalculatorSpec } from './bar-tube-calculator-spec';

export const BAR_TUBE_CALCULATORS_MIGRATION = 1091;

/** The SQL of migrations/1091_bar_tube_calculators.sql, built from the spec. */
export function buildBarTubeCalculatorsMigrationSql(): string {
  // The calculators 1091 created, as it created them: an entry a later migration replaced is still generated here, and a later one is not.
  return buildDomainCalculatorsMigrationSql(loadBarTubeCalculatorSpec({ includeSuperseded: true }), {
    number: BAR_TUBE_CALCULATORS_MIGRATION,
    title: 'Bar and Tube Fabrication calculators -- stock, cutting (saw, shear, tube laser, plate and torch), punching, end forming, bending and extrusion as real database calculators.',
    generator: 'scripts/generate-bar-tube-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/bar-tube/calculators/bar-tube-calculators.json',
    rootCause: [
      'Bar and Tube Fabrication was staged (reference data 2026-BarTube: 50 variables, 14 lookup tables; 277 HR Rates machines, 93 materials)',
      'but had no cost engine: its 34 catalog processes had no calculator, and a part whose Process is Bar and Tube Fabrication was not costed.',
      'These are the calculators of its processes: the stock and plate per part, sawing, shearing, tube laser, plate and torch cutting, punching,',
      'end forming, rotary draw, compression, bend brake, roll and profile bending, and aluminium extrusion with its billet and die preheat.',
    ].join('\n'),
  }, (c) => c.migration == null);
}

export const BAR_TUBE_SAW_BUNDLE_MIGRATION = 1117;

/** The SQL of migrations/1117_bar_tube_saw_bundle.sql: the saw cut whose cutting time is not shared over the bundle. */
export function buildBarTubeSawBundleMigrationSql(): string {
  return buildDomainCalculatorsMigrationSql(loadBarTubeCalculatorSpec(), {
    number: BAR_TUBE_SAW_BUNDLE_MIGRATION,
    title: 'Bar and Tube - Saw cut, version 2 -- a bundle shares the index and the handling, not the cutting.',
    generator: 'scripts/generate-bar-tube-calculators-migration.ts',
    specPath: 'src/modules/bom-items/costing/bar-tube/calculators/bar-tube-calculators.json',
    rootCause: [
      'Migration 1091 divided the whole saw cycle by the parts in a bundle: (cut + index + load and unload) / parts per bundle. A blade removes',
      'metal at its cutting rate however many bars lie under it, so a bundle of n bars takes n times the cut of one: each part still pays for',
      'its own section. Dividing the cut by the bundle made a full bundle of 18 bars saw about 18 times faster than the saw can cut.',
      'Version 2 shares only what the bundle does share (one index, one load and unload) and cuts every part\'s section; the engine reads the',
      'cutting rate at the bundle\'s width in the cut, and never bundles more bars than the batch needs.',
    ].join('\n'),
  }, (c) => c.migration === BAR_TUBE_SAW_BUNDLE_MIGRATION);
}
