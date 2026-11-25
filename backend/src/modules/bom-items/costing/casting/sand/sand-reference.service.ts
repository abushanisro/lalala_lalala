import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../../../common/database/database.service';
import { resolveSandReference, SAND_CASTING_SOURCE_VERSION, type SandReference } from './sand-reference';

/**
 * Loads the staged memory/Sand casting rows (variables and lookup tables, source version 2026-SandCasting) and resolves them
 * (sand-reference.ts). One read per process: every sand step reads the same rows, and a successful read is cached; a read error
 * is reported and not cached. Machines and materials are editable rows and are read where they are used, not here.
 */
@Injectable()
export class SandReferenceService {
  constructor(private readonly database: DatabaseService) {}

  private cached: SandReference | null = null;

  async get(): Promise<{ reference: SandReference | null; missing: string[] }> {
    if (this.cached) return { reference: this.cached, missing: [] };
    const read = await readStagedReference(this.database, SAND_CASTING_SOURCE_VERSION, 'Sand casting', 853);
    if (read.reference) this.cached = read.reference;
    return read;
  }
}

/** The reference's own region: memory/'s data is staged under it, and a location with no row of its own reads it. */
export const STAGED_REFERENCE_REGION = 'USA';

/**
 * One row per key: the row staged for `region` where there is one, else the reference's own (USA) row. A location's own rule (India's bar
 * length, from the machining workbook) is staged beside the reference's under its source_region and replaces it there only; a row staged
 * for another location is never read (India's bar end is not the USA's). A row with no region is the reference's.
 */
export function rowsForRegion<T extends { key: string; source_region?: string | null }>(rows: readonly T[], region: string | null | undefined): T[] {
  const own = (r: T) => region != null && r.source_region === region;
  const reference = (r: T) => r.source_region == null || r.source_region === STAGED_REFERENCE_REGION;
  const byKey = new Map<string, T>();
  for (const r of rows) {
    if (!own(r) && !reference(r)) continue;
    const held = byKey.get(r.key);
    if (!held || (own(r) && !own(held))) byKey.set(r.key, r);
  }
  return [...byKey.values()];
}

/**
 * The staged variables and lookup tables of one reference-data source version, resolved (sand-reference.ts): the read every casting route that
 * keeps its reference this way shares. A read error or an unstaged version is reported by name, never an empty reference. `region` is the
 * location the reference is read for: a row staged for it replaces the reference's own (rowsForRegion); absent, the reference's own rows.
 */
export async function readStagedReference(
  database: DatabaseService, sourceVersion: string, label: string, stagedBy: number, region?: string | null,
): Promise<{ reference: SandReference | null; missing: string[] }> {
  // Public-read reference data with no user context.
  const db = database.getPrivilegedClient('reference-data: machining_reference_data, public-read');
  const [variables, lookups] = await Promise.all([
    db.from('machining_reference_data').select('key, value, unit_type, source_region')
      .eq('category', 'variable').eq('source_version', sourceVersion),
    db.from('machining_reference_data').select('key, raw, source_region')
      .eq('category', 'lookup_table').eq('source_version', sourceVersion),
  ]);
  const error = variables.error ?? lookups.error;
  if (error) return { reference: null, missing: [`${label} reference data (${error.message})`] };
  if (!(variables.data ?? []).length && !(lookups.data ?? []).length) {
    return { reference: null, missing: [`${label} reference data is not staged (source version ${sourceVersion}, migration ${stagedBy})`] };
  }
  return {
    reference: resolveSandReference({ variables: rowsForRegion(variables.data ?? [], region), lookups: rowsForRegion(lookups.data ?? [], region) }),
    missing: [],
  };
}
