// The rest of Stock Machining's reference data (migration 1114): its remaining lookup tables, processes and operations staged under
// 2026-Stock-Machining, the Material Stock machine for USA and India, and the machine classes of its catalog rows, from memory/Stock Maching.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface Csv { columns: string[]; rows: Record<string, string | number | boolean | null | undefined>[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as { readCsv: (path: string) => Csv };

const BACKEND = join(__dirname, '../../../../../..');
const MEMORY = join(BACKEND, '../memory');
const DIR = join(MEMORY, 'Stock Maching');
const migration = () => readFileSync(join(BACKEND, 'migrations/1114_stock_machining_reference.sql'), 'utf8');
const JSONB = '$jsonb$';

/** The rows a lookup table is staged with: the `rows` of its jsonb. */
function stagedRows(table: string): Record<string, unknown>[] {
  const line = migration().split('\n').find((l) => l.startsWith(`  ($str$lookup_table$str$, 'USA', $str$2026-Stock-Machining$str$, $str$${table}$str$,`));
  if (!line) throw new Error(`${table} is not staged`);
  const json = line.slice(line.indexOf(JSONB) + JSONB.length, line.lastIndexOf(JSONB));
  return (JSON.parse(json) as { rows: Record<string, unknown>[] }).rows;
}

describe("the rest of Stock Machining's reference data (migration 1114)", () => {
  it('is what the generator writes from memory/', () => {
    const committed = migration();
    execFileSync('node', [join(BACKEND, 'scripts/generate-stock-machining-reference-migration.js')], { stdio: 'ignore' });
    expect(migration()).toBe(committed);
  });

  it("stages the whole preferred stock sizes table: every size of memory/Stock Maching's cut-down export, and the sizes it leaves out", () => {
    const whole = stagedRows('tblPreferredSizes');
    expect(whole).toHaveLength(814);
    const key = (unit: unknown, size: unknown) => `${String(unit)}|${Number(size).toFixed(4)}`;
    const staged = new Set(whole.map((r) => key(r.unitSystem, r.sizeMm)));
    const partial = readCsv(join(DIR, 'lookup/tblPreferredSizes_PARTIAL.csv')).rows;
    expect(partial).toHaveLength(507);
    for (const r of partial) expect(staged.has(key(r['Unit System'], r['Size (mm)']))).toBe(true);
    // The export in memory/Stock Maching has no size between 1016 mm (40 in) and 4394.2 mm: the whole table has them.
    expect(staged.has(key('US', 1219.2))).toBe(true);
    expect(partial.some((r) => r['Unit System'] === 'US' && Number(r['Size (mm)']) === 1219.2)).toBe(false);
    // Inch sizes for the USA, metric elsewhere: 5/8 in and 16 mm are each in their own series.
    expect(whole).toContainEqual({ sizeMm: 15.875, unitSystem: 'US', comment: '5/8"' });
    expect(whole).toContainEqual({ sizeMm: 16, unitSystem: 'metric', comment: '16 mm' });
    expect(new Set(whole.map((r) => r.unitSystem))).toEqual(new Set(['US', 'metric', 'both']));
  });

  it('stages the parting ring widths, the plate part spacings and the validation display controls as the files have them', () => {
    expect(stagedRows('tblPartingRingWidth')).toEqual([{ diameterMm: 25, ringWidthMm: 2.5 }, { diameterMm: 50, ringWidthMm: 5 }, { diameterMm: 110, ringWidthMm: 8 }]);
    const spacing = stagedRows('tblPartSpacing');
    expect(spacing).toEqual(readCsv(join(DIR, 'lookup/tblPartSpacing.csv')).rows);
    expect(spacing).toHaveLength(199);
    // A laser leaves the plate's own thickness between parts, a plasma torch twice it, a waterjet 5.08 mm whatever the thickness.
    expect(spacing).toContainEqual({ 'Part Spacing (mm)': 6, Process: 'Laser Cut', 'Thickness (mm)': 6 });
    expect(spacing).toContainEqual({ 'Part Spacing (mm)': 12, Process: 'Plasma Cut', 'Thickness (mm)': 6 });
    expect(spacing).toContainEqual({ 'Part Spacing (mm)': 5.08, Process: 'Waterjet Cut', 'Thickness (mm)': 6 });
    expect(stagedRows('validationDisplayControls')).toContainEqual({ 'Panel Name': 'Stock Form', Display: 'yes' });
  });

  it("stages the group's three processes and three operations", () => {
    const sql = migration();
    for (const p of readCsv(join(DIR, 'processes.csv')).rows) expect(sql).toContain(`($str$process$str$, 'USA', $str$2026-Stock-Machining$str$, $str$${String(p['Process Name'])}$str$,`);
    for (const o of ['Band Saw:Band Saw//StockTrim', 'Material Stock:As Supplied//CurvedWall', 'Material Stock:As Supplied//PlanarFace']) {
      expect(sql).toContain(`($str$operation$str$, 'USA', $str$2026-Stock-Machining$str$, $str$${o}$str$,`);
    }
    expect(sql).toContain('ON CONFLICT (category, source_region, source_version, key) DO NOTHING;');
  });

  it('adds the Material Stock machine for USA and India: the stock as supplied, no operator, no rate, 6096 mm bars', () => {
    const machine = readCsv(join(DIR, 'Machine/machines_material_stock.csv')).rows;
    expect(machine).toHaveLength(1);
    expect(machine[0]).toMatchObject({ Name: 'Default Material Stock', 'Labor Rate (USD / hr)': 0, 'Direct Overhead Rate (USD / hr)': 0, 'Indirect Overhead Rate (USD / hr)': 0,
      'Number of Operators': 0, 'Standard Stock Length (mm)': 6096, 'Avg Utilization': 0.78 });
    const rows = migration().split('\n').filter((l) => l.startsWith('  ($str$stock_machining_material_stock$str$,'));
    expect(rows.map((l) => l.split(', ')[1])).toEqual(['$str$USA$str$', '$str$India$str$']);
    for (const l of rows) {
      expect(l).toContain('$str$Default Material Stock$str$, $str$USD$str$');
      expect(l).toContain('$str$Stock Machining$str$, 0, 0, 0, 0, 1, 0, $str$0 - Metal$str$, 0.78, 1,');
      expect(l).toContain('"standard_stock_length_mm":6096');
    }
    // No export lists a rate for it: the India row is the India export's, at none.
    const india = readCsv(join(MEMORY, 'Countries data/India_XML_Data_.csv')).rows
      .find((r) => r.Commodity === 'Stock Machining' && r['Machine Type'] === 'Material Stock');
    expect(india).toMatchObject({ name: 'Default Material Stock', customWorkCenterDirectOverheadRate: 0, customWorkCenterIndirectOverheadRate: 0, numOperators: 0 });
  });

  it('gives the two catalog rows their machine classes, adds User-Defined Process, and leaves the band saws and stock prices alone', () => {
    const sql = migration();
    expect(sql).toContain("FROM (VALUES ('Band Saw', $str$band_saw$str$), ('Material Stock', $str$stock_machining_material_stock$str$)) AS v(process_name, machine_class)");
    expect(sql).toContain("SELECT $str$Stock Machining$str$, 'User-Defined Process', 'non_mfg', true, 1502,");
    expect(sql).not.toContain('UPDATE mhr_records');
    expect(sql).not.toContain('INSERT INTO material_stock_prices');
    // The India export lists the reference file's 13 saws with the file's own data (the generator checks all 14 exports).
    const saws = readCsv(join(DIR, 'Machine/machines_band_saw.csv')).rows;
    const india = readCsv(join(MEMORY, 'Countries data/India_XML_Data_.csv')).rows.filter((r) => r.Commodity === 'Stock Machining' && r['Machine Type'] === 'Band Saw');
    expect(india.map((r) => r.name).sort()).toEqual(saws.map((m) => m.Name).sort());
    expect(india.find((r) => r.name === 'DoAll C-330NC')).toMatchObject({ axialFeedRate: 75, loadTime: 60, unloadTime: 15, maxStockDiameter: 330, setupTime: 0.17 });
  });
});
