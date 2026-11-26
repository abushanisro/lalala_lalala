/**
 * Writes migration 1164 (the machining and sheet metal machines' preferred and virtual flags) from memory/:
 *   node scripts/generate-machine-preference-flags-migration.js
 *
 * The reference data chooses a machine in this order: the machines the part fits, of them the plant's preferred ones
 * (variable usePreferredMachines: "the model will first try to select a preferred machine"), and for machining a virtual machine first
 * (variable preferVirtualMachines: "first try to select a virtual machine, if present and feasible based on size constraints"). Each
 * machine's own flag is in its machine file (other.isPreferred / other.is_preferred, other.isVirtualMachine / other.is_virtual_machine;
 * sheet metal: is_preferred), but the machining and sheet metal machines were staged on mhr_records without them, so the engine could
 * not follow the rule and ranked those machines by a score of its own. Written by machine class and name to every location's rows, as
 * specs keys (the keys the other families' machines already carry):
 *   is_preferred         true / false
 *   is_virtual_machine   true / false (only where the machine file has the column)
 * A machine whose file leaves the flag empty gets no key: it is not preferred, and not known to be virtual.
 */
const { writeFileSync } = require('fs');
const { join } = require('path');
const { readCsv } = require('../migrations/scripts/lib/memory-machine-seed.js');

const MEMORY = join(__dirname, '../../memory');
const OUT = join(__dirname, '../migrations/1164_machine_preference_flags.sql');

/** machiningusa.csv lists several machine types: its primaryId is the type, mapped to the HR Rates machine_class. */
const MACHINING_USA_CLASS = {
  '2 Axis Lathe': '2_axis_lathe', '3 Axis Lathe': '3_axis_lathe',
  '2 Axis Bar Feed Lathe with Sub Spindle': '2_axis_bar_feed_lathe_with_sub_spindle',
  '3 Axis Bar Feed Lathe with Sub Spindle': '3_axis_bar_feed_lathe_with_sub_spindle',
  '3 Axis Mill': '3_axis_mill', '4 Axis Mill': '4_axis_mill', '5 Axis Mill': '5_axis_mill',
  '3 Axis Router': '3_axis_router', '5 Axis Router': '5_axis_router',
  'Automated Deburr': 'automated_deburr', 'Manual Bench Cell': 'manual_bench_cell', 'Bevel Gear Cutting Machine': 'bevel_gear_cutting_machine',
};
/** memory/Sheetmetal/machine/machine_library.csv: its machine_category, mapped to the HR Rates machine_class. */
const SHEET_METAL_CLASS = {
  '2 Roll Bender': 'roll_bending_2', '3 Roll Bender': 'roll_bending_3', '4 Roll Bender': 'roll_bending_4',
  '2-Axis Router': 'router_2axis', '3D Laser Cutting Machine': 'laser_3d', 'Bend Press Brake': 'press_brake',
  'Cut To Length Line (CTL)': 'cut_to_length', 'Deslag Machine': 'deburring', 'Fiber Laser Cutting Machine': 'fiber_laser',
  'Laser Cutting Machine': 'co2_laser', 'Laser Punch / Punch Press': 'laser_punch', 'Oxyfuel Cutting Machine': 'oxyfuel_cut',
  'Plasma Cutting Machine': 'plasma_cut', 'Plasma Punch': 'plasma_punch', 'Progressive Die Press': 'progressive_die_press',
  'Shearing Machine': 'shear', 'Standard Press': 'standard_press', 'Tandem Press': 'tandem_press',
  'Turret Press (Punch Press)': 'turret_punch', 'Waterjet Cutting Machine': 'waterjet',
};

const machining = (file, machineClass) => ({ file: `Machining/machine/${file}`, classOf: () => machineClass });
// Each source file and the machine class of its rows. The name, preferred and virtual columns are found by their spelling.
const SOURCES = [
  { file: 'Machining/machine/machiningusa.csv', classOf: (r) => MACHINING_USA_CLASS[String(r.primaryId).trim()] ?? null },
  machining('broach_machines_usa.csv', 'broach'),
  machining('cylindrical_grinder_machines_usa.csv', 'cylindrical_grinder'),
  machining('deep_bore_machine_usa.csv', 'deep_bore_machine'),
  machining('demask_usa.csv', 'demask'),
  machining('drill_press_usa.csv', 'drill_press'),
  machining('etch_cell_usa.csv', 'etch_cell'),
  machining('gun_drill_usa.csv', 'gun_drill'),
  machining('hob_machine_usa.csv', 'hob_machine'),
  machining('inspection_usa.csv', 'machining_inspection'),
  machining('internal_grinder_usa.csv', 'internal_grinder'),
  machining('jig_bore_usa.csv', 'jig_bore'),
  machining('jig_grind_usa.csv', 'jig_grind'),
  machining('manual_deburr_usa.csv', 'manual_deburr'),
  machining('mask_cure_usa.csv', 'mask_cure'),
  machining('millturn_usa.csv', 'machining_millturn'),
  machining('profile_gear_grinder_usa.csv', 'profile_gear_grinder'),
  machining('reciprocating_surface_grinder_usa.csv', 'reciprocating_surface_grinder'),
  machining('rotary_surface_grinder_usa.csv', 'rotary_surface_grinder'),
  machining('scribe_usa.csv', 'scribe'),
  machining('shaper_usa.csv', 'shaper'),
  machining('shaver_usa.csv', 'shaver'),
  machining('simultaneous_turning_usa.csv', 'simultaneous_turning'),
  machining('special_inspection_usa.csv', 'special_inspection'),
  machining('spline_roller_usa.csv', 'spline_roller'),
  machining('stock_prep_lathe_usa.csv', 'stock_prep_lathe'),
  machining('stock_prep_mill_work_center_data.csv', 'stock_prep_mill'),
  machining('threaded_wheel_gear_grinder_work_center_data.csv', 'threaded_wheel_gear_grinder'),
  machining('wire_edm_work_center_data.csv', 'wire_edm'),
  { file: 'Sheetmetal/machine/machine_library.csv', classOf: (r) => SHEET_METAL_CLASS[String(r.machine_category).trim()] ?? null },
];

const NAME_COLUMNS = ['name', 'primary_id.name'];
const PREFERRED = /(^|\.)is_?preferred$/i;
const VIRTUAL = /(^|\.)is_?virtual_?machine$/i;

const q = (s) => `$str$${s}$str$`;
/** A flag as the file writes it (True / False / true / false); null when the cell is empty. */
const flag = (v, what) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return null;
  if (s !== 'true' && s !== 'false') throw new Error(`${what}: not a flag "${v}"`);
  return s === 'true';
};

const machines = new Map();
for (const src of SOURCES) {
  const { rows } = readCsv(join(MEMORY, src.file));
  const columns = Object.keys(rows[0] ?? {});
  const nameColumn = NAME_COLUMNS.find((c) => columns.includes(c));
  const preferredColumn = columns.find((c) => PREFERRED.test(c));
  const virtualColumn = columns.find((c) => VIRTUAL.test(c));
  if (!nameColumn || !preferredColumn) throw new Error(`${src.file}: no name or preferred column (${columns.slice(0, 8).join(', ')}, ...)`);
  for (const r of rows) {
    const machineClass = src.classOf(r);
    if (!machineClass) throw new Error(`${src.file}: no machine class for ${JSON.stringify(r[nameColumn])} (${r.primaryId ?? r.machine_category})`);
    const name = String(r[nameColumn]).trim();
    const preferred = flag(r[preferredColumn], `${src.file} ${name} preferred`);
    const virtual = virtualColumn ? flag(r[virtualColumn], `${src.file} ${name} virtual`) : null;
    if (preferred == null && virtual == null) continue; // the file leaves both empty: nothing to stage
    const key = `${machineClass}\u0000${name}`;
    if (machines.has(key)) throw new Error(`${machineClass} ${name} listed twice`);
    machines.set(key, { machineClass, name, preferred, virtual });
  }
}
const list = [...machines.values()].sort((a, b) => a.machineClass.localeCompare(b.machineClass) || a.name.localeCompare(b.name));
const classes = [...new Set(list.map((m) => m.machineClass))].sort();
const count = (test) => list.filter(test).length;

const sqlFlag = (v) => (v == null ? 'NULL::boolean' : String(v));
const row = (m) => `  (${[q(m.machineClass), q(m.name), sqlFlag(m.preferred), sqlFlag(m.virtual)].join(', ')})`;

const sql = `-- ============================================================================
-- Migration 1164: the machining and sheet metal machines' preferred and virtual flags
-- ============================================================================
-- Generated by scripts/generate-machine-preference-flags-migration.js; re-run it and diff instead of editing.
--
-- The reference data chooses a machine in this order: the machines the part fits; of them the plant's preferred machines
-- (variable usePreferredMachines: "the model will first try to select a preferred machine"); and for machining a virtual
-- machine first (variable preferVirtualMachines: "first try to select a virtual machine, if present and feasible based on
-- size constraints"). Each machine's own flag is in its machine file (memory/Machining/machine/*.csv: other.isPreferred,
-- other.isVirtualMachine and their spellings; memory/Sheetmetal/machine/machine_library.csv: is_preferred), but these two
-- families' machines were staged on mhr_records without them, so the rule could not be followed.
--
-- Written by machine class and name to every location's rows, as specs keys (the keys the other families' machines carry):
--   is_preferred         true / false
--   is_virtual_machine   true / false (only where the machine file has the column)
-- ${list.length} machines in ${classes.length} classes: ${count((m) => m.preferred === true)} preferred, ${count((m) => m.virtual === true)} virtual. A machine whose file leaves a flag empty gets no key for it.
--
-- Idempotent: the same values are re-set.
-- Verify: SELECT machine_class, location, count(*), count(*) FILTER (WHERE specs->>'is_preferred' = 'true') AS preferred,
--                count(*) FILTER (WHERE specs->>'is_virtual_machine' = 'true') AS virtual
--           FROM mhr_records WHERE process_group IN ('Machining', 'Sheet Metal') GROUP BY 1, 2 ORDER BY 1, 2;
-- ============================================================================

UPDATE mhr_records m SET
  specs = COALESCE(m.specs, '{}'::jsonb)
    || CASE WHEN v.is_preferred IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('is_preferred', v.is_preferred) END
    || CASE WHEN v.is_virtual_machine IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('is_virtual_machine', v.is_virtual_machine) END,
  updated_at = now()
FROM (VALUES
${list.map(row).join(',\n')}
) AS v(machine_class, machine_name, is_preferred, is_virtual_machine)
WHERE m.machine_class = v.machine_class AND m.machine_name = v.machine_name
  -- One standard press row (Standard Press - 3,000kN, USA: aluminium 20 mm under mild steel 90 mm) breaks ck_mhr_aluminium_not_below_steel,
  -- which migration 713 added NOT VALID on purpose until that row is re-imported. No statement can update it, so it is left as it is:
  -- it gets no flag, which reads as not preferred (its file says false).
  AND (m.max_thickness_al_mm IS NULL OR m.max_thickness_ms_mm IS NULL OR m.max_thickness_al_mm >= m.max_thickness_ms_mm);

NOTIFY pgrst, 'reload schema';
`;

writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${list.length} machines, ${classes.length} classes, ${count((m) => m.preferred === true)} preferred, ${count((m) => m.virtual === true)} virtual)`);
