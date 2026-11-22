import { readFileSync } from 'fs';
import { join } from 'path';
import { MachiningLookupService } from '../../../../../../modules/bom-items/costing/machining/lookup/machining-lookup.service';
import { type DatabaseService } from '../../../../../../common/database/database.service';

// The op-splitting tables as the database holds them: the rows migration 748 staged, under the reference export's own column names. The
// reader once looked for snake_case names no staged row has, so no split was ever found and a multi-spindle never shared an operation
// over its stations.
const SQL = readFileSync(join(__dirname, '../../../../../../../migrations/748_stage_machining_lookup_tables_part10of13.sql'), 'utf8');
const JSON_MARK = ['$', 'jsonb', '$'].join('');

/** The rows migration 748 stages for a lookup table. */
function staged(key: string): unknown[] {
  const at = SQL.indexOf(['$str$', key, '$str$'].join(''));
  if (at < 0) throw new Error(`migration 748 does not stage ${key}`);
  const from = SQL.indexOf(JSON_MARK, at) + JSON_MARK.length;
  return JSON.parse(SQL.slice(from, SQL.indexOf(JSON_MARK, from))) as unknown[];
}

/** A lookup service whose table reads return the staged rows of the table asked for. */
function lookup(tables: Record<string, unknown[]>) {
  const client = () => {
    let table = '';
    const chain: any = {
      select: () => chain,
      eq: (column: string, value: string) => {
        if (column === 'key') table = value;
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: tables[table] ? { raw: tables[table] } : null, error: null }),
    };
    return chain;
  };
  return new MachiningLookupService({ getPrivilegedClient: () => ({ from: client }) } as unknown as DatabaseService);
}

describe('MachiningLookupService.getMultiSpindleOpSplit, on the rows migration 748 staged', () => {
  const service = () => lookup({
    tblMultiSpindleOpSplitting: staged('tblMultiSpindleOpSplitting'),
    tblMultiSpindleOpSplittingThresholds: staged('tblMultiSpindleOpSplittingThresholds'),
  });
  const none = { shouldSplit: false, numberOfOperations: 1, thresholdRatio: null, dataFound: false };

  it('rough turning of a Ring is shared over 2 stations on a 6-spindle and 3 on an 8-spindle, once 0.22 of the removed volume is the ring\'s', async () => {
    await expect(service().getMultiSpindleOpSplit('Ring', 'Rough Turning', 6)).resolves.toEqual({ shouldSplit: true, numberOfOperations: 2, thresholdRatio: 0.22, dataFound: true });
    await expect(service().getMultiSpindleOpSplit('Ring', 'Rough Turning', 8)).resolves.toEqual({ shouldSplit: true, numberOfOperations: 3, thresholdRatio: 0.22, dataFound: true });
  });

  it('a twin-spindle keeps the operation on one station: the table says 1', async () => {
    await expect(service().getMultiSpindleOpSplit('Ring', 'Rough Turning', 2)).resolves.toMatchObject({ dataFound: true, numberOfOperations: 1 });
  });

  it('drilling a hole is shared over 3 stations once the hole is 0.8 of the part\'s length', async () => {
    await expect(service().getMultiSpindleOpSplit('SimpleHole', 'Drilling', 6)).resolves.toEqual({ shouldSplit: true, numberOfOperations: 3, thresholdRatio: 0.8, dataFound: true });
  });

  it('finds no rule for a spindle count, an operation or a feature the table does not list', async () => {
    await expect(service().getMultiSpindleOpSplit('Ring', 'Rough Turning', 4)).resolves.toEqual(none);
    await expect(service().getMultiSpindleOpSplit('Ring', 'Finish Turning', 6)).resolves.toEqual(none);
    await expect(service().getMultiSpindleOpSplit('Keyway', 'Rough Turning', 6)).resolves.toEqual(none);
  });

  it('finds none when the tables are not staged', async () => {
    await expect(lookup({}).getMultiSpindleOpSplit('Ring', 'Rough Turning', 6)).resolves.toEqual(none);
  });
});
