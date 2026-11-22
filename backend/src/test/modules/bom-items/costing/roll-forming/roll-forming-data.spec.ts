// The Sheet Metal Roll Forming machine data (migration 1112): the USA line machines at the Netherlands overheads and the USA labour of their
// wage grade, their India twins, and the process group's material group, from memory/Sheet metal roll forming and memory/Countries data.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface Csv { columns: string[]; rows: Record<string, string | number | boolean | null | undefined>[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as { readCsv: (path: string) => Csv };

const BACKEND = join(__dirname, '../../../../../..');
const MIGRATIONS = join(BACKEND, 'migrations');
const MEMORY = join(BACKEND, '../memory');
const DIR = join(MEMORY, 'Sheet metal roll forming');
const machinesSql = () => readFileSync(join(MIGRATIONS, '1112_roll_forming_machines.sql'), 'utf8');
const cents = (v: unknown) => Math.round(Number(String(v).replace(/[$\s,]/g, '')) * 100) / 100;

/** The export's roll forming row of a machine of a process (the exports spell one press "Mulitpress"). */
function exportRow(country: string, process: string, name: string): Record<string, unknown> {
  const t = readCsv(join(MEMORY, 'Countries data', `${country}_XML_Data_.csv`));
  const row = t.rows.find((r) => r.Commodity === 'Sheet Metal - Roll Forming' && r['Machine Type'] === process
    && String(r.name).replace(/^Mulitpress\b/, 'Multipress') === name);
  if (!row) throw new Error(`${country}: no ${process} ${name}`);
  return row;
}

describe('the Sheet Metal Roll Forming machines (migration 1112)', () => {
  it('is what the generator writes from memory/', () => {
    const committed = machinesSql();
    execFileSync('node', [join(BACKEND, 'scripts/generate-roll-forming-machines-migration.js')], { stdio: 'ignore' });
    expect(machinesSql()).toBe(committed);
  });

  it("rates each USA line machine at the Netherlands overheads and its grade's USA labour, only while it holds the World Average rates 862 seeded", () => {
    const mills = readCsv(join(DIR, 'Machines/roll_forming_mill_machines.csv')).rows;
    expect(mills).toHaveLength(37);
    for (const m of mills) {
      const nl = exportRow('Netherlands', 'Roll Forming Mill', String(m.Name));
      const seeded = `${cents(m['Direct Overhead Rate (USD / hr)'])}::numeric, ${cents(m['Indirect Overhead Rate (USD / hr)'])}::numeric, 43.99::numeric`;
      expect(machinesSql()).toContain(
        `$str$${String(m.Name)}$str$, ${cents(nl.customWorkCenterDirectOverheadRate)}::numeric, ${cents(nl.customWorkCenterIndirectOverheadRate)}::numeric, 43.21::numeric, ${seeded},`);
    }
    // memory/Countries data/Netherlands: the default mill 25.06 + 14.95 USD/hr (World Average 22.22 + 15.25, labour 43.99).
    expect(machinesSql()).toContain('$str$Bradbury 2.5" Shaft Diameter 12 stand$str$, 25.06::numeric, 14.95::numeric, 43.21::numeric, 22.22::numeric, 15.25::numeric, 43.99::numeric');
    expect(machinesSql()).toContain('AND m.direct_overhead_rate = v.seed_direct AND m.indirect_overhead_rate = v.seed_indirect AND COALESCE(m.usd_labor_rate_per_hr, 0) = v.seed_labour;');
  });

  it('gives the mill the 4 - Metal labour, the coil stock none and every other line machine the 3 - Metal labour', () => {
    const grades = new Map(readCsv(join(DIR, 'roll_forming_wage_grades.csv')).rows.map((r) => [String(r['Process Name']), r['Wage Grade Name']]));
    expect(grades.get('Roll Forming Mill')).toBe('4 - Metal');
    expect(grades.get('Coil Material Stock')).toBe('0 - Metal');
    for (const p of ['Uncoiler', 'Coil Flattener', 'Punch Press', 'Cut-Off Press', 'Integrated HFI Welding']) expect(grades.get(p)).toBe('3 - Metal');
    const usa = machinesSql().split('\n').filter((l) => l.startsWith('  ($str$sheet_roll_forming_') && l.includes('::numeric'));
    const labour = (cls: string) => new Set(usa.filter((l) => l.startsWith(`  ($str$${cls}$str$`)).map((l) => l.split(', ')[4]));
    expect(labour('sheet_roll_forming_roll_forming_mill')).toEqual(new Set(['43.21::numeric']));
    expect(labour('sheet_roll_forming_uncoiler')).toEqual(new Set(['36.3::numeric']));
    expect(labour('sheet_roll_forming_coil_material_stock')).toEqual(new Set(['0::numeric']));
  });

  it("twins all 125 in India at the India export's overheads and the grade's India labour", () => {
    const twins = machinesSql().split('\n').filter((l) => l.startsWith('    ($str$India$str$'));
    expect(twins).toHaveLength(125);
    // memory/Countries data/India: the default mill 17.97 + 1.26 USD/hr, labour 4 - Metal 2.30.
    expect(twins.join('\n')).toContain('$str$sheet_roll_forming_roll_forming_mill$str$, $str$Bradbury 2.5" Shaft Diameter 12 stand$str$, 2.3, 17.97, 1.26,');
    const press = exportRow('India', 'Cut-Off Press', '4 Post Hydraulic Press 150 Ton 2" Press Stroke');
    expect(twins.join('\n')).toContain(
      `$str$sheet_roll_forming_cut_off_press$str$, $str$4 Post Hydraulic Press 150 Ton 2" Press Stroke$str$, 1.73, ${cents(press.customWorkCenterDirectOverheadRate)}, ${cents(press.customWorkCenterIndirectOverheadRate)},`);
  });

  it('links the process group to its own material group', () => {
    expect(machinesSql()).toContain("SELECT $str$Sheet Metal Roll Forming$str$, $str$Sheet Metal Roll Forming$str$");
  });
});
