// The real memory/PCBA data as the staged rows the PCB engine reads, for the PCB tests. Everything is read from the folder.
import { readdirSync } from 'fs';
import { join } from 'path';
import { resolveSandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';
import type { SandMachine } from '../../../../../modules/bom-items/costing/casting/sand/sand-machines';
import { laminateOf } from '../../../../../modules/bom-items/costing/pcb/pcb-laminates';
import { PCB_CLASS, type PcbLaminate } from '../../../../../modules/bom-items/costing/pcb/pcb-route';
import { PCBA_CLASS } from '../../../../../modules/bom-items/costing/pcb/pcb-assembly';
import { machineOf } from '../additive/additive-test-data';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv, specKey } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pcbaAssemblyMachines } = require('../../../../../../scripts/lib/pcba-assembly-machines.js');
export const PCB_DIR = join(__dirname, '../../../../../../../memory/PCBA');
const rows = (rel: string): Array<Record<string, any>> => readCsv(join(PCB_DIR, rel)).rows;

const stagedVariables = rows('pcb_variables.csv').map((r) => ({ key: String(r['Variable Name']), value: r['String Value'] == null ? null : String(r['String Value']), unit_type: r['Unit Type Name'] || null }));
// The stack-up tables (migration 823) and the sourced tables (migration 1130), staged as lookup tables of 2026-PCB.
const stagedLookups = [
  ...readdirSync(join(PCB_DIR, 'Lookup')).filter((f) => f.endsWith('.csv')).map((f) => ({ key: f.replace(/\.csv$/, ''), raw: { rows: rows(`Lookup/${f}`) } })),
  ...['consumables', 'process_times', 'yield'].map((t) => ({ key: t, raw: { rows: rows(`${t}.csv`) } })),
  // The sourced assembly tables (migration 1133).
  ...['assembly_rates', 'assembly_costs'].map((t) => ({ key: t, raw: { rows: rows(`Assembly/${t}.csv`) } })),
];
export const realPcbReference = () => resolveSandReference({ variables: stagedVariables, lookups: stagedLookups });

// Each machine file as migration 797 seeded it: some pools back more than one process (the drills, the screen printers).
const FILE_CLASS: [string, string][] = [
  ['surface_preparation_machines.csv', PCB_CLASS.surfacePrep], ['apply_photo_resist_machines.csv', PCB_CLASS.resist], ['photolithography_machines.csv', PCB_CLASS.litho],
  ['des_line_machine.csv', PCB_CLASS.des], ['aoi_machines.csv', PCB_CLASS.aoi], ['default_machine.csv', PCB_CLASS.bench], ['lauffer_rmv125_machine.csv', PCB_CLASS.laminate],
  ['drilling_machines.csv', PCB_CLASS.regDrill], ['drilling_machines.csv', PCB_CLASS.drill], ['laser_drill_machines.csv', PCB_CLASS.laser],
  ['plating_line_gating_tank_machines.csv', PCB_CLASS.pth], ['photo_resist_developer_machine.csv', PCB_CLASS.dissolve], ['plating_line_gating_cell_machines.csv', PCB_CLASS.plate],
  ['ses_line_machine.csv', PCB_CLASS.ses], ['screen_printing_machines.csv', PCB_CLASS.plug], ['conveyor_dryer_machines.csv', PCB_CLASS.plugCure],
  ['wet_film_solder_mask_machines.csv', PCB_CLASS.mask], ['tack_dry_solder_mask_machines.csv', PCB_CLASS.tackDry], ['exposure_machines.csv', PCB_CLASS.film],
  ['solder_mask_developer_machine.csv', PCB_CLASS.develop], ['rack_oven_machines.csv', PCB_CLASS.maskCure], ['screen_printing_machines.csv', PCB_CLASS.legend],
  ['silkscreen_cure_machines.csv', PCB_CLASS.legendCure], ['hasl_machines.csv', PCB_CLASS.hasl], ['plating_line_machines.csv', PCB_CLASS.enig],
  ['osp_line_machine.csv', PCB_CLASS.osp], ['router_machines.csv', PCB_CLASS.router], ['stamp_machines.csv', PCB_CLASS.stamp],
  ['flying_probe_machines.csv', PCB_CLASS.flyingProbe], ['bed_of_nails_machines.csv', PCB_CLASS.bedOfNails], ['avi_machines.csv', PCB_CLASS.avi],
];

// wet_film_solder_mask_machines.csv was exported with shortened headers: the columns as the other files name them (migration 797 read them so).
const HEADER_ALIAS: Readonly<Record<string, string>> = {
  direct_overhead_rate: 'direct_overhead_rate_usd_per_hr', indirect_overhead_rate: 'indirect_overhead_rate_usd_per_hr', number_of_truncated_header: 'number_of_operators',
};

/** The USA machines of memory/PCBA/Machine, by class, as HR Rates holds them. */
export function allPcbMachines(): Record<string, SandMachine[]> {
  const out: Record<string, SandMachine[]> = {};
  for (const [file, cls] of FILE_CLASS) {
    out[cls] = rows(`Machine/${file}`).map((r, i) => machineOf(Object.fromEntries(Object.entries(r).map(([h, v]) => {
      const key = specKey(String(h).replace(/^\uFEFF/, ''));
      return [HEADER_ALIAS[key] ?? key, v];
    })), cls, i));
  }
  // The assembly machines as migration 1133 seeds them (the same lib), at their USA rates.
  type Assembled = { p: { cls: string; usaLabour: number; operators: number; setup: number }; name: string; kw: number; usa: { direct: number; indirect: number }; specs: Record<string, unknown> };
  const { machines } = pcbaAssemblyMachines(join(PCB_DIR, '..')) as { machines: Assembled[] };
  for (const cls of Object.values(PCBA_CLASS).filter((c) => c !== PCBA_CLASS.bench)) {
    out[cls] = machines.filter((m) => m.p.cls === cls).map((m, i) => machineOf({
      name: m.name, labor_rate_usd_per_hr: m.p.usaLabour, direct_overhead_rate_usd_per_hr: m.usa.direct, indirect_overhead_rate_usd_per_hr: m.usa.indirect,
      number_of_operators: m.p.operators, setup_time_hr: m.p.setup, machine_power_kw: m.kw, ...m.specs,
    }, cls, i));
  }
  return out;
}

/** The laminates of memory/PCBA/raw_materials.csv as the cost service reads them (raw_materials: base cost per m², dielectric). */
export function pcbLaminates(): PcbLaminate[] {
  return rows('raw_materials.csv').map((r) => laminateOf({
    id: `raw-materials:${r['Name']}`, name: String(r['Name']), usdPerM2: Number(r['Base Cost Per Unit (USD)']),
    dielectricMm: r['Dielectric Thickness (mm)'] == null ? null : Number(r['Dielectric Thickness (mm)']),
  }));
}
