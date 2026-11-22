// The real memory/Sheet metal roll forming data as the staged rows and HR Rates machines the engine reads, for the roll forming tests: the
// variables and lookup tables (staged by migration 863 under 2026-RollForm), the line machines of each place (migration 862's specs), rated as
// migration 1112 rates them (USA: the Netherlands export's overheads and the USA labour of the wage grade; India: the India export's and the
// India labour), the tool shop, the materials and memory's catalog. Everything is read from memory/ (CI checks it out case-sensitively:
// "Sheet metal roll forming", "Countries data", "Lookup", "Machines", "Processes", "Raw Materials").
import { readdirSync } from 'fs';
import { join } from 'path';

import { sandMachineFromRow, type SandMachine } from '../../../../../modules/bom-items/costing/casting/sand/sand-machines';
import { resolveSandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';
import { ROLL_FORMING_CLASS, type RollFormingMaterial } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-route';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv, specKey } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as {
  readCsv: (p: string) => { columns: string[]; rows: Record<string, unknown>[] };
  specKey: (h: string) => string;
};

const MEMORY = join(__dirname, '../../../../../../../memory');
const DIR = join(MEMORY, 'Sheet metal roll forming');
const rows = (path: string) => readCsv(path).rows;

export const realVariables = () => rows(join(DIR, 'roll_forming_variables.csv'))
  .map((r) => ({ key: String(r['Variable Name']), value: r['String Value'] == null ? null : String(r['String Value']), unit_type: (r['Unit Type Name'] as string) || null }));
const stagedLookups = readdirSync(join(DIR, 'Lookup')).filter((f) => f.endsWith('.csv')).map((f) => ({ key: f.replace(/\.csv$/, ''), raw: { rows: rows(join(DIR, 'Lookup', f)) } }));
export const realLookups = () => stagedLookups;
export const realRollFormingReference = () => resolveSandReference({ variables: realVariables(), lookups: stagedLookups });

/** Each place on the line: its process, its machine file and its machine class (migration 862). */
const FILES: Record<string, { file: string; machineClass: string }> = {
  'Coil Material Stock': { file: 'coil_material_stock_machine.csv', machineClass: ROLL_FORMING_CLASS.stock },
  Uncoiler: { file: 'uncoiler_machines.csv', machineClass: ROLL_FORMING_CLASS.uncoiler },
  'Coil Flattener': { file: 'coil_flattener_machines.csv', machineClass: ROLL_FORMING_CLASS.flattener },
  'Punch Press': { file: 'punch_press_machines.csv', machineClass: ROLL_FORMING_CLASS.punch },
  'Roll Forming Mill': { file: 'roll_forming_mill_machines.csv', machineClass: ROLL_FORMING_CLASS.mill },
  'Cut-Off Press': { file: 'cut_off_press_machines.csv', machineClass: ROLL_FORMING_CLASS.cutoff },
  'Integrated HFI Welding': { file: 'integrated_hfi_welding_machines.csv', machineClass: ROLL_FORMING_CLASS.hfi },
  'Integrated Laser Welding': { file: 'integrated_laser_welding_machine.csv', machineClass: ROLL_FORMING_CLASS.laser },
  'Integrated Rotary Spot Welding': { file: 'integrated_rotary_spot_welding_machines.csv', machineClass: ROLL_FORMING_CLASS.rotarySpot },
  'Integrated TIG Welding': { file: 'integrated_tig_welding_machine.csv', machineClass: ROLL_FORMING_CLASS.tig },
};
/** The labour of each wage grade (USD/hr), as migration 1112 takes it. */
export const GRADE_LABOUR: Record<string, { USA: number; India: number }> = { '4 - Metal': { USA: 43.21, India: 2.3 }, '3 - Metal': { USA: 36.3, India: 1.73 }, '0 - Metal': { USA: 0, India: 0 } };
const grades = new Map(rows(join(DIR, 'roll_forming_wage_grades.csv')).map((r) => [String(r['Process Name']), String(r['Wage Grade Name'])]));
const machineName = (s: unknown) => String(s).trim().replace(/^Mulitpress\b/, 'Multipress');
/** A country export's Sheet Metal - Roll Forming row of each machine, by process and name. */
function exportRows(file: string): Map<string, Record<string, unknown>> {
  return new Map(rows(join(MEMORY, 'Countries data', file)).filter((r) => String(r.Commodity).trim() === 'Sheet Metal - Roll Forming')
    .map((r) => [`${String(r['Machine Type']).trim()}|${machineName(r.name)}`, r]));
}
const EXPORT = { USA: exportRows('Netherlands_XML_Data_.csv'), India: exportRows('India_XML_Data_.csv') };
/** The columns of a machine file that are mhr_records columns, not specs (migration 862). */
const TOP_LEVEL = new Set(['name', 'labor_rate_usd_per_hr', 'direct_overhead_rate_usd_per_hr', 'indirect_overhead_rate_usd_per_hr', 'number_of_operators', 'setup_time_hr', 'machine_power_kw']);
const cents = (v: unknown) => Math.round(Number(String(v).replace(/[$\s,]/g, '')) * 100) / 100;

/** The line's machines of a location, rated as migration 1112 rates them. */
export function rollFormingMachines(location: 'USA' | 'India' = 'USA'): Record<string, SandMachine[]> {
  const out: Record<string, SandMachine[]> = {};
  for (const [process, { file, machineClass }] of Object.entries(FILES)) {
    out[machineClass] = rows(join(DIR, 'Machines', file)).map((r, i) => {
      const row = Object.fromEntries(Object.entries(r).map(([h, v]) => [specKey(h.replace(/^\uFEFF/, '')), v]));
      const name = machineName(row.name);
      const rate = EXPORT[location].get(`${process}|${name}`);
      if (!rate) throw new Error(`${location}: no export row for ${process} ${name}`);
      const grade = grades.get(process)!;
      const labour = GRADE_LABOUR[grade][location];
      const specs = Object.fromEntries(Object.entries(row).filter(([k]) => !TOP_LEVEL.has(k)));
      return sandMachineFromRow({
        id: `${machineClass}-${location}-${i}`, machine_name: name, machine_class: machineClass, location,
        mhr_usd_per_hour: Math.round((cents(rate.customWorkCenterDirectOverheadRate) + cents(rate.customWorkCenterIndirectOverheadRate)) * 100) / 100,
        usd_labor_rate_per_hr: labour, operators: row.number_of_operators, setup_time_hr: row.setup_time_hr, machine_power_kw: row.machine_power_kw,
        specs: {
          ...specs,
          rate_basis: location === 'USA'
            ? `overheads memory/Countries data/Netherlands_XML_Data_.csv (no export lists the USA); labour ${grade} USA ${labour.toFixed(2)}`
            : `overheads memory/Countries data/India_XML_Data_.csv; labour ${grade} India ${labour.toFixed(2)}`,
        },
      }, () => null);
    });
  }
  return out;
}

/** A material of memory/Sheet metal roll forming/Raw Materials/material_master.csv, as the cost service reads it (raw_materials and its strengths). */
export function rollFormingMaterial(name: string): RollFormingMaterial {
  const r = rows(join(DIR, 'Raw Materials', 'material_master.csv')).find((m) => m.Name === name);
  if (!r) throw new Error(`no roll forming material ${name}`);
  const n = (h: string) => (r[h] == null || r[h] === '' ? null : Number(r[h]));
  return {
    id: `raw-materials:${name}`, name, materialType: String(r['Material Type']), densityKgM3: n('Density (kg/m^3)'), costPerKgUsd: n('Unit Cost (USD/kg)'),
    utsMpa: n('Ultimate Tensile Strength (MPa)'), yieldMpa: n('Tensile Yield Strength (MPa)'), shearStrengthMpa: n('Shear Strength (MPa)'),
  };
}

/** Memory's catalog of the process (memory/Sheet metal roll forming/Processes, staged as process_taxonomy_operations): each row once. */
export const realRollFormingCatalog = (): string[] =>
  [...new Set(rows(join(DIR, 'Processes', 'roll_forming_operations.csv')).map((r) => (typeof r['Process Name'] === 'string' ? r['Process Name'].trim() : '')).filter((s) => s.includes('//')))];
