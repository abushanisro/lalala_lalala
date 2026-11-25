import type { SourceRef } from '../../dto/cost-breakdown.dto';

/**
 * Tables a calculator input is read from that are not a staged reference domain, served by GET /processes/reference-lookup as if they were
 * one (processes.service.ts getReferenceLookup), so a 'lookup' ref opens them like any staged table, with the value's row outlined:
 *
 * - the plastic-molding reference package (plastic-molding/reference/*.csv, the CSVs the cost model reads, each row with its source), and
 * - the costing tables of the database a value is read from directly (location_electricity_prices).
 */
export const PLASTIC_REFERENCE_PACKAGE_DOMAIN = 'plastic_reference_package';
export const COSTING_TABLES_DOMAIN = 'costing_tables';

/** The reference package's files a lookup ref may name (the only ones the endpoint serves: never a path). */
export const PLASTIC_REFERENCE_PACKAGE_FILES = [
  'dryer-equipment-reference.csv',
  'dryer-models-reference.csv',
  'equipment-economics-reference.csv',
  'gate-sizing-reference.csv',
  'material-drying-reference.csv',
  'mold-design-reference.csv',
  'mold-steel-treatment-reference.csv',
  'quality-inspection-reference.csv',
] as const;
export type PlasticReferencePackageFile = (typeof PLASTIC_REFERENCE_PACKAGE_FILES)[number];

/** The database tables served under COSTING_TABLES_DOMAIN. */
export const COSTING_TABLES = ['location_electricity_prices'] as const;

export const isServedTableDomain = (domain: unknown): domain is typeof PLASTIC_REFERENCE_PACKAGE_DOMAIN | typeof COSTING_TABLES_DOMAIN =>
  domain === PLASTIC_REFERENCE_PACKAGE_DOMAIN || domain === COSTING_TABLES_DOMAIN;

/** A row of a reference package file: the column the value is in, the row identified by its key columns. */
export const referencePackageRef = (file: PlasticReferencePackageFile, column: string, row: Record<string, string | number>): SourceRef =>
  ({ kind: 'lookup', domain: PLASTIC_REFERENCE_PACKAGE_DOMAIN, table: file, column, row });

/** The location's row of location_electricity_prices (its price, in its own currency). */
export const electricityRef = (location: string): SourceRef =>
  ({ kind: 'lookup', domain: COSTING_TABLES_DOMAIN, table: 'location_electricity_prices', column: 'price_per_kwh', row: { location } });
