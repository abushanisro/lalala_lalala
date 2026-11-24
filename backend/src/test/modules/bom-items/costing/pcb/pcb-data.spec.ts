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

describe('the sourced PCB fabrication reference (migration 1130)', () => {
  const referenceSql = () => readFileSync(join(MIGRATIONS, '1130_pcb_sourced_reference.sql'), 'utf8');

  it('is what the generator writes from memory/', () => {
    const committed = referenceSql();
    execFileSync('node', [join(BACKEND, 'scripts/generate-pcb-reference-migration.js')], { stdio: 'ignore' });
    expect(referenceSql()).toBe(committed);
  });

  it('stages each file whole as a 2026-PCB lookup table, every row with its source', () => {
    for (const [name, file] of [['consumables', 'PCBA/consumables.csv'], ['process_times', 'PCBA/process_times.csv'], ['yield', 'PCBA/yield.csv']] as const) {
      const t = readCsv(join(MEMORY, file));
      expect(referenceSql()).toContain(`($str$lookup_table$str$, 'USA', $str$2026-PCB$str$, $str$${name}$str$, $str$${t.rows.length}$str$,`);
      for (const r of t.rows) {
        expect(String(r.source_url)).toMatch(/^https?:\/\//);
        expect(String(r.source_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('holds the values the engine reads, by key, each with a lower and an upper end', () => {
    const keyed = (file: string, key: string) => readCsv(join(MEMORY, file)).rows.filter((r) => r.item_key === key);
    for (const key of ['prepreg_usd_per_kg', 'solder_mask_usd_per_kg', 'dry_film_usd_per_m2', 'tin_usd_per_kg', 'nickel_usd_per_kg', 'gold_usd_per_g', 'drill_bit_usd',
      'drill_hit_life_hits', 'drill_repoints', 'router_bit_usd', 'router_bit_life_mm', 'entry_board_usd_per_sheet', 'backup_board_usd_per_sheet', 'drill_board_sheet_in',
      'bed_of_nails_fixture_usd', 'flying_probe_program_usd', 'stamp_die_usd', 'tin_density_g_cm3', 'nickel_density_g_cm3', 'gold_density_g_cm3']) {
      const rows = keyed('PCBA/consumables.csv', key);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(Number(r.value_max)).toBeGreaterThanOrEqual(Number(r.value_min));
    }
    for (const key of ['working_panel_in', 'tin_thickness_um', 'tin_rate_um_per_min', 'nickel_thickness_um', 'gold_thickness_um', 'gold_dwell_min', 'hasl_dwell_s', 'dryer_heated_length_ft', 'solder_mask_solids_pct']) {
      expect(keyed('PCBA/process_times.csv', key).length).toBeGreaterThan(0);
    }
    // The working panel the fabs run: 18 x 24 in.
    expect(keyed('PCBA/process_times.csv', 'working_panel_in')[0]).toMatchObject({ value_min: 18, value_max: 24 });
    expect(keyed('PCBA/yield.csv', 'fab_yield_pct').map((r) => Number(r.layer_count_min))).toEqual(expect.arrayContaining([4, 8, 12, 16, 20]));
  });
});

describe('the PCB assembly data (migration 1133)', () => {
  const assemblySql = () => readFileSync(join(MIGRATIONS, '1133_pcba_assembly_machines_and_reference.sql'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pcbaAssemblyMachines } = require('../../../../../../scripts/lib/pcba-assembly-machines.js');
  const built = () => pcbaAssemblyMachines(MEMORY) as {
    RULE: Record<'USA' | 'India', { n: number; worst: number }>;
    machines: { p: { cls: string; operators: number; setup: number; grade: string }; name: string; price: number; usa: { direct: number; indirect: number }; india: { direct: number; indirect: number }; specs: Record<string, unknown> }[];
    skipped: { used: string[]; unpriced: string[]; other: string[] };
  };

  it('is what the generator writes from memory/', () => {
    const committed = assemblySql();
    execFileSync('node', [join(BACKEND, 'scripts/generate-pcba-assembly-migration.js')], { stdio: 'ignore' });
    expect(assemblySql()).toBe(committed);
  });

  it('prices each machine by the reference\'s own overhead rule, which reproduces every reference PCB machine to the cent', () => {
    const { RULE, machines } = built();
    expect(RULE.USA.n).toBeGreaterThan(90);
    expect(RULE.India.n).toBeGreaterThan(90);
    expect(RULE.USA.worst).toBeLessThan(0.01);
    expect(RULE.India.worst).toBeLessThan(0.01);
    // The placer: 67,000 USD, no power stated. USA direct 6.0535e-5 x 67,000 = 4.06; indirect 13.83 + 0.0855 x its floor area (0.22).
    const placer = machines.find((m) => m.name === 'Yamaha YSM20R')!;
    expect(placer.usa.direct).toBeCloseTo(4.06, 2);
    expect(placer.usa.direct + placer.usa.indirect).toBeCloseTo(18.11, 2);
    expect(placer.specs).toMatchObject({ rated_cph: 95000, ipc_cph: 57000, power_note: expect.any(String) });
    // The Juki rate the maker states at IPC-9850 is a used listing: not seeded.
    expect(machines.some((m) => m.name.startsWith('Juki'))).toBe(false);
  });

  it('seeds new listings only, a listing range at its midpoint, and the crew of the analogous fabrication machine', () => {
    const { machines, skipped } = built();
    expect(machines).toHaveLength(24);
    expect(skipped.used).toEqual(expect.arrayContaining(['Juki RS-1R', 'Desen DSP-1008 (listing price low)', 'Teradyne Spectrum 9 TSE 8862 (used 2006)']));
    expect(machines.find((m) => m.name === 'GKG G5')!.price).toBe((24915 + 38000) / 2);
    expect(machines.find((m) => m.name === 'I.C.T-Q588A online ICT')!.price).toBe((13500 + 35800) / 2);
    const crew = Object.fromEntries(machines.map((m) => [m.p.cls, [m.p.operators, m.p.setup, m.p.grade]]));
    // An SMT line machine's setup is the line changeover; the SPI shares an operator as the reference's in-line vision inspection does.
    expect(crew['pcba_stencil_printer']).toEqual([1, 0, '4 - Metal']);
    expect(crew['pcba_solder_paste_inspection']).toEqual([0.5, 0, '3 - Metal']);
    expect(crew['pcba_reflow']).toEqual([0, 0, '3 - Metal']);
    expect(crew['pcba_in_circuit_test']).toEqual([1, 0.17, '3 - Metal']);
    expect(crew['pcba_flying_probe']).toEqual([0, 0.17, '4 - Metal']);
  });

  it('stages the assembly rates and costs, every row sourced, and adds the catalog\'s assembly processes with their machine classes', () => {
    for (const name of ['assembly_rates', 'assembly_costs']) {
      const t = readCsv(join(MEMORY, `PCBA/Assembly/${name}.csv`));
      expect(assemblySql()).toContain(`($str$lookup_table$str$, 'USA', $str$2026-PCB$str$, $str$${name}$str$, $str$${t.rows.length}$str$,`);
      for (const r of t.rows) expect(String(r.source_url)).toMatch(/^https?:\/\//);
    }
    for (const [process, cls] of [['Stencil Print', 'pcba_stencil_printer'], ['Pick and Place', 'pcba_pick_and_place'], ['THT Insertion', 'pcb_bench_operation'], ['Depanel Router', 'pcba_depanel_router']]) {
      expect(assemblySql()).toContain(`($str$PCB$str$, $str$${process}$str$, $str$${cls}$str$,`);
    }
  });
});
