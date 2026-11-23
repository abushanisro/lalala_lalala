// The PCB fabrication machine data (migration 1129): the India twins of the USA machines of migration 797, from memory/Countries data and
// memory/PCBA, and the machine classes of the PCB catalog rows.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface Csv { columns: string[]; rows: Record<string, string | number | boolean | null | undefined>[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as { readCsv: (path: string) => Csv };

const BACKEND = join(__dirname, '../../../../../..');
const MIGRATIONS = join(BACKEND, 'migrations');
const MEMORY = join(BACKEND, '../memory');
const machinesSql = () => readFileSync(join(MIGRATIONS, '1129_pcb_machines_india_and_classes.sql'), 'utf8');
const twins = () => machinesSql().split('\n').filter((l) => /^ {2}\(\$str\$[a-z_]+\$str\$, \$str\$/.test(l) && l.includes(':India$str$'));

describe('the PCB fabrication machines at India rates (migration 1129)', () => {
  it('is what the generator writes from memory/', () => {
    const committed = machinesSql();
    execFileSync('node', [join(BACKEND, 'scripts/generate-pcb-machines-migration.js')], { stdio: 'ignore' });
    expect(machinesSql()).toBe(committed);
  });

  it('twins every PCB machine of the India export once, at its overheads (to cents) and the India rate of its wage grade', () => {
    const rows = twins();
    expect(rows).toHaveLength(98);
    // memory/Countries data/India_XML_Data_.csv, PCB: HASL Large 16.01553 + 0.91519 USD/hr; Hot Air Solder Leveling is 3 - Metal (1.73).
    expect(rows.join('\n')).toContain('($str$hot_air_solder_leveling$str$, $str$HASL Large$str$, 1.73, 16.02, 0.92,');
    // Copper Plate and Tin Coat is 4 - Metal (2.30): the 10-cell line at 170.3695 + 17.92924.
    expect(rows.join('\n')).toContain('($str$copper_plate_and_tin_coat$str$, $str$Plating Line - 10 Gating Cells - 4900mm x 640mm$str$, 2.3, 170.37, 17.93,');
    // Material Stock is a virtual machine with no labour (0 - Metal).
    expect(rows.join('\n')).toContain('($str$material_stock$str$, $str$Default$str$, 0, 0, 0.86,');
    const grades = new Map(readCsv(join(MEMORY, 'PCBA/wage_grade_associations (4).csv')).rows.map((r) => [String(r['Process Name']), r['Wage Grade Name']]));
    expect([grades.get('Hot Air Solder Leveling'), grades.get('Copper Plate and Tin Coat'), grades.get('Material Stock')]).toEqual(['3 - Metal', '4 - Metal', '0 - Metal']);
  });

  it('copies each India machine under the USA seed name, and leaves out the export\'s legacy plating types', () => {
    const rows = twins().join('\n');
    expect(rows).toContain('$str$Tampprinter PCB Drying Oven$str$');
    expect(rows).not.toContain('Tamprinter PCB');
    const exported = readCsv(join(MEMORY, 'Countries data/India_XML_Data_.csv')).rows.filter((r) => r.Commodity === 'PCB');
    const legacy = exported.filter((r) => ['Copper Plate', 'Tin Coat', 'Desmear', 'Plate Through Holes'].includes(String(r['Machine Type'])));
    expect(legacy).toHaveLength(9);
    expect(machinesSql()).toContain('Not copied: Copper Plate (3), Desmear (2), Plate Through Holes (1), Tin Coat (3).');
  });

  it('gives every PCB process with a machine its migration 797 class, in the catalog and the calculator mappings', () => {
    const processes = readCsv(join(MEMORY, 'PCBA/processes.csv')).rows.map((r) => String(r['Process Name']))
      .filter((p) => !['No Cost Feature', 'User-Defined Process'].includes(p));
    expect(processes).toHaveLength(32);
    for (const p of processes) expect(machinesSql()).toMatch(new RegExp(`\\(\\$str\\$${p.replace(/[()]/g, '\\$&')}\\$str\\$, \\$str\\$[a-z_]+\\$str\\$\\)`));
    expect(machinesSql()).toContain("WHERE t.process_group = 'PCB' AND t.process_name = v.process AND t.machine_class IS NULL;");
    expect(machinesSql()).toContain("WHERE m.process_group = 'PCB' AND m.process_route = v.process AND m.operation = v.process AND m.machine_class IS NULL;");
  });
});
