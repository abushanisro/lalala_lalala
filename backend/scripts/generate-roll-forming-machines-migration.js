#!/usr/bin/env node
/**
 * Writes migration 1112 (the Sheet Metal Roll Forming machines: the USA line machines at the user's chosen rates, their India twins, and the
 * process group's material group) from memory/Sheet metal roll forming and memory/Countries data:
 *   node scripts/generate-roll-forming-machines-migration.js
 * Re-run and diff instead of editing the migration.
 */
const { readdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { readCsv, sqlStr, sqlNum, twinMachinesSql } = require('../migrations/scripts/lib/memory-machine-seed.js');

const MEMORY = join(__dirname, '../../memory');
const DIR = 'Sheet metal roll forming';
const COUNTRIES = 'Countries data';
const OUT = join(__dirname, '../migrations/1112_roll_forming_machines.sql');
// The process group as the database has it (migrations 855, 862, 863); the exports name the same machines under this commodity.
const GROUP = 'Sheet Metal Roll Forming';
const COMMODITY = 'Sheet Metal - Roll Forming';
// Each line process: its World Average machine file (migration 862 seeded the USA rows from it) and the machine class 862 gave it.
const PROCESSES = {
  'Coil Flattener': 'coil_flattener_machines.csv',
  'Coil Material Stock': 'coil_material_stock_machine.csv',
  'Cut-Off Press': 'cut_off_press_machines.csv',
  'Integrated HFI Welding': 'integrated_hfi_welding_machines.csv',
  'Integrated Laser Welding': 'integrated_laser_welding_machine.csv',
  'Integrated Rotary Spot Welding': 'integrated_rotary_spot_welding_machines.csv',
  'Integrated TIG Welding': 'integrated_tig_welding_machine.csv',
  'Punch Press': 'punch_press_machines.csv',
  'Roll Forming Mill': 'roll_forming_mill_machines.csv',
  Uncoiler: 'uncoiler_machines.csv',
};
const classOf = (process) => `sheet_roll_forming_${process.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
// The USA rate (the user's decision, 2026-11-22, as for Hydroforming): no export lists the USA, so the overheads are the Netherlands export's.
const USA_PROXY = 'Netherlands_XML_Data_.csv';
const INDIA = 'India_XML_Data_.csv';
// The labour of each wage grade (USD/hr): the rate most of the grade's HR Rates rows carry (SELECT location, wage_grade, usd_labor_rate_per_hr,
// count(*) FROM mhr_records ... GROUP BY 1, 2, 3): USA 4 - Metal 43.21 (289 rows), 3 - Metal 36.30 (560); India 4 - Metal 2.30 (238),
// 3 - Metal 1.73 (294), as migrations 1049, 1063, 1089 and 1109 took them. 0 - Metal is the coil as supplied: no operator.
const GRADE_RATE = { '4 - Metal': { USA: 43.21, India: 2.30 }, '3 - Metal': { USA: 36.30, India: 1.73 }, '0 - Metal': { USA: 0, India: 0 } };
// Columns of a machine the exports must agree on (its own timing and size, not a country's rate).
const MACHINE_COLUMNS = ['setupTime', 'maxLineSpeed', 'strokesPerMinute', 'coilLoadTime', 'numRollStands', 'shaftDiameter', 'maxStockThickness',
  'maxSectionHeight', 'maxCoilCapacity', 'maxStockWidth'];

/** A number as an export writes it: plain, or "$ 56.26" / "$ -" (Canada, China, Mexico, Singapore). */
const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$\s,]/g, '');
  if (s === '-') return 0;
  return s === '' || !Number.isFinite(Number(s)) ? null : Number(s);
};
const cents = (v, what) => {
  const n = num(v);
  if (n == null || n < 0) throw new Error(`not a rate: ${what} = ${v}`);
  return Math.round(n * 100) / 100;
};
// One press is spelt "Mulitpress" in the exports and "Multipress" in the World Average files (and the database).
const machineName = (s) => String(s).trim().replace(/^Mulitpress\b/, 'Multipress');

// The wage grade of each process, and the World Average machines (the USA rows of migration 862: name and seeded rates).
const grades = Object.fromEntries(readCsv(join(MEMORY, DIR, 'roll_forming_wage_grades.csv')).rows.map((r) => [r['Process Name'], r['Wage Grade Name']]));
const seed = {};
for (const [process, file] of Object.entries(PROCESSES)) {
  if (!GRADE_RATE[grades[process]]) throw new Error(`${process}: wage grade ${grades[process]} has no rate here`);
  seed[process] = readCsv(join(MEMORY, DIR, 'Machines', file)).rows.map((r) => ({
    name: machineName(r['Name']),
    direct: cents(r['Direct Overhead Rate (USD / hr)'], `${process} ${r['Name']}`),
    indirect: cents(r['Indirect Overhead Rate (USD / hr)'], `${process} ${r['Name']}`),
    labour: cents(r['Labor Rate (USD / hr)'], `${process} ${r['Name']}`),
    setup: num(r['Setup Time (hr)']),
  }));
}

// Every export's roll forming rows, by process and machine name; columns matched by their trimmed header (Singapore pads them).
function exportRows(file) {
  const t = readCsv(join(MEMORY, COUNTRIES, file));
  const col = (name) => t.columns.find((c) => c.trim() === name);
  const out = new Map();
  for (const r of t.rows.filter((row) => String(row[col('Commodity')]).trim() === COMMODITY)) {
    out.set(`${String(r[col('Machine Type')]).trim()}|${machineName(r[col('name')])}`, { get: (name) => (col(name) ? r[col(name)] : undefined) });
  }
  return out;
}
const exportsByFile = Object.fromEntries(readdirSync(join(MEMORY, COUNTRIES)).filter((f) => f.endsWith('.csv')).sort().map((f) => [f, exportRows(f)]));
const expected = Object.entries(seed).flatMap(([process, ms]) => ms.map((m) => `${process}|${m.name}`)).sort();
for (const [file, rows] of Object.entries(exportsByFile)) {
  if (JSON.stringify([...rows.keys()].sort()) !== JSON.stringify(expected)) throw new Error(`${file}: its ${COMMODITY} machines are not the World Average files'`);
}
// A machine's own data is the same in every export (checked), and its setup time is the World Average file's (which rounds it to 0.01 h).
const proxy = exportsByFile[USA_PROXY];
for (const [file, rows] of Object.entries(exportsByFile)) {
  for (const [key, r] of rows) {
    for (const c of MACHINE_COLUMNS) {
      if (num(r.get(c)) !== num(proxy.get(key).get(c))) throw new Error(`${file} ${key}: ${c} ${r.get(c)} differs from ${USA_PROXY}'s ${proxy.get(key).get(c)}`);
    }
  }
}
for (const [process, ms] of Object.entries(seed)) {
  for (const m of ms) {
    const s = num(proxy.get(`${process}|${m.name}`).get('setupTime'));
    if (Math.abs(s - m.setup) > 0.005) throw new Error(`${process} ${m.name}: setup time ${s} in the exports, ${m.setup} in the World Average file`);
  }
}

const usaBasis = (process) => `overheads memory/${COUNTRIES}/${USA_PROXY} (no export lists the USA); labour ${grades[process]} USA ${GRADE_RATE[grades[process]].USA.toFixed(2)}`;
const indiaBasis = (process) => `overheads memory/${COUNTRIES}/${INDIA}; labour ${grades[process]} India ${GRADE_RATE[grades[process]].India.toFixed(2)}`;

// USA: the Netherlands overheads and the USA labour of the grade, replacing the World Average rates migration 862 seeded (and only those).
const usa = Object.entries(seed).flatMap(([process, ms]) => ms.map((m) => {
  const r = proxy.get(`${process}|${m.name}`);
  return {
    process, cls: classOf(process), name: m.name, seed: m,
    direct: cents(r.get('customWorkCenterDirectOverheadRate'), `NL ${m.name}`), indirect: cents(r.get('customWorkCenterIndirectOverheadRate'), `NL ${m.name}`),
    labour: GRADE_RATE[grades[process]].USA,
  };
})).sort((a, b) => (a.cls + a.name).localeCompare(b.cls + b.name));

// India: twins of all of them, the India export's overheads and the India labour of the grade.
const india = exportsByFile[INDIA];
const twins = usa.map((u) => {
  const r = india.get(`${u.process}|${u.name}`);
  return {
    location: 'India', countryCode: 'IN', machineClass: u.cls, machineName: u.name, labour: GRADE_RATE[grades[u.process]].India,
    direct: cents(r.get('customWorkCenterDirectOverheadRate'), `India ${u.name}`), indirect: cents(r.get('customWorkCenterIndirectOverheadRate'), `India ${u.name}`),
    sourceKey: `${u.process}:${u.name}:India`,
  };
});

const materials = readCsv(join(MEMORY, DIR, 'Raw Materials', 'material_master.csv')).rows.length;
const byProcess = Object.entries(seed).map(([p, ms]) => `--   ${p.padEnd(32)}${String(ms.length).padStart(3)} machine(s), ${classOf(p)}, ${grades[p]}`).join('\n');
const mill = usa.find((u) => u.name === 'Bradbury 2.5" Shaft Diameter 12 stand');
const millIndia = twins.find((t) => t.machineName === mill.name);

const sql = `-- ============================================================================
-- Migration 1112: the Sheet Metal Roll Forming machines -- USA rates, India twins, and the material group
-- ============================================================================
-- Generated by scripts/generate-roll-forming-machines-migration.js; re-run it and diff instead of editing.
--
-- Sheet Metal Roll Forming is costed (user decision 2026-11-22). Migration 862 seeded its ${usa.length} line machines for the USA only, at the
-- memory files' "World Average" rates (memory/${DIR}/Machines), not a country's; no machine for India; and no material group for the process.
--
-- 1. USA: direct and indirect overhead (USD/hr, to cents) from memory/${COUNTRIES}/${USA_PROXY} (the user's decision: no export lists the
--    USA, as for Hydroforming, migration 1109), and the USA labour of the process's wage grade (memory/${DIR}/roll_forming_wage_grades.csv;
--    the rate most of that grade's HR Rates rows carry): 4 - Metal ${GRADE_RATE['4 - Metal'].USA.toFixed(2)}, 3 - Metal ${GRADE_RATE['3 - Metal'].USA.toFixed(2)}, 0 - Metal (the coil as supplied) 0.
--    A row is changed only while it still holds the World Average rates 862 seeded, so a rate entered in HR Rates is kept.
--    e.g. the default mill ${mill.name}: ${mill.seed.direct} + ${mill.seed.indirect}, labour ${mill.seed.labour} -> ${mill.direct} + ${mill.indirect}, labour ${mill.labour}.
-- 2. India: the twins of all ${twins.length} (memory/${COUNTRIES}/${INDIA}, commodity "${COMMODITY}"): each machine's own overheads and the India
--    labour of the grade, 4 - Metal ${GRADE_RATE['4 - Metal'].India.toFixed(2)}, 3 - Metal ${GRADE_RATE['3 - Metal'].India.toFixed(2)}, 0 - Metal 0; specs as the USA twin's (e.g. the default mill
--    ${millIndia.direct} + ${millIndia.indirect}, labour ${millIndia.labour.toFixed(2)}).
--    The ${Object.keys(exportsByFile).length} exports list the same ${usa.length} machines and agree on each machine's own data (setup time, line speed, strokes per minute,
--    coil load time, stands, shaft, stock limits), which is the World Average files' (checked when this file is generated).
-- 3. process_material_groups: Sheet Metal Roll Forming draws on its own material group (its ${materials} materials, memory/${DIR}/Raw Materials/material_master.csv, migration 855).
--
${byProcess}
--
-- Idempotent. Verify:
--   SELECT location, machine_class, count(*), min(mhr_usd_per_hour), max(usd_labor_rate_per_hr) FROM mhr_records
--   WHERE process_group = '${GROUP}' GROUP BY 1, 2 ORDER BY 1, 2;
-- ============================================================================

UPDATE mhr_records m SET
  direct_overhead_rate = v.direct, indirect_overhead_rate = v.indirect,
  benchmark_direct_overhead_rate_usd_hr = v.direct, benchmark_indirect_overhead_rate_usd_hr = v.indirect,
  total_machine_hour_rate = v.direct + v.indirect, mhr_usd_per_hour = v.direct + v.indirect,
  usd_labor_rate_per_hr = v.labour, usd_lhr_total = v.labour, benchmark_labor_rate_usd_hr = v.labour,
  specs = COALESCE(m.specs, '{}'::jsonb) || jsonb_build_object('rate_basis', v.basis),
  updated_at = now()
FROM (VALUES
${usa.map((u) => `  (${sqlStr(u.cls)}, ${sqlStr(u.name)}, ${sqlNum(u.direct)}::numeric, ${sqlNum(u.indirect)}::numeric, ${sqlNum(u.labour)}::numeric, ${sqlNum(u.seed.direct)}::numeric, ${sqlNum(u.seed.indirect)}::numeric, ${sqlNum(u.seed.labour)}::numeric, ${sqlStr(usaBasis(u.process))})`).join(',\n')}
) AS v(machine_class, machine_name, direct, indirect, labour, seed_direct, seed_indirect, seed_labour, basis)
WHERE m.process_group = ${sqlStr(GROUP)} AND m.location = 'USA' AND m.machine_class = v.machine_class AND m.machine_name = v.machine_name
  AND m.direct_overhead_rate = v.seed_direct AND m.indirect_overhead_rate = v.seed_indirect AND COALESCE(m.usd_labor_rate_per_hr, 0) = v.seed_labour;

${twinMachinesSql({ tag: 'roll_forming_machines', processGroup: GROUP, twins })}

UPDATE mhr_records m SET specs = m.specs || jsonb_build_object('rate_basis', v.basis), updated_at = now()
FROM (VALUES
${Object.keys(PROCESSES).map((p) => `  (${sqlStr(classOf(p))}, ${sqlStr(indiaBasis(p))})`).join(',\n')}
) AS v(machine_class, basis)
WHERE m.process_group = ${sqlStr(GROUP)} AND m.location = 'India' AND m.machine_class = v.machine_class AND m.specs IS NOT NULL
  AND m.specs ->> 'rate_basis' IS DISTINCT FROM v.basis;

DO $roll_forming_material_group$
BEGIN
  -- Absent only in a stripped-down database (the local data stub): nothing to link there.
  IF to_regclass('public.process_material_groups') IS NULL THEN RETURN; END IF;
  INSERT INTO public.process_material_groups (process_group, material_group)
  SELECT ${sqlStr(GROUP)}, ${sqlStr(GROUP)}
   WHERE NOT EXISTS (SELECT 1 FROM public.process_material_groups WHERE process_group = ${sqlStr(GROUP)} AND material_group = ${sqlStr(GROUP)});
  IF NOT EXISTS (SELECT 1 FROM public.raw_materials WHERE material_group = ${sqlStr(GROUP)}) THEN
    RAISE EXCEPTION '${GROUP}: raw_materials holds none of its materials (migration 855)';
  END IF;
END $roll_forming_material_group$;

DO $roll_forming_check$
DECLARE bad text[]; kept text[]; n integer;
BEGIN
  SELECT count(*) INTO n FROM mhr_records WHERE process_group = ${sqlStr(GROUP)} AND location = 'India' AND machine_class LIKE 'sheet_roll_forming_%';
  IF n <> ${twins.length} THEN RAISE EXCEPTION 'expected ${twins.length} India ${GROUP} machines, found %', n; END IF;
  SELECT array_agg(location || ': ' || machine_name ORDER BY location, machine_name) INTO bad FROM mhr_records
   WHERE process_group = ${sqlStr(GROUP)} AND location IN ('USA', 'India') AND machine_class LIKE 'sheet_roll_forming_%'
     AND NOT COALESCE(mhr_usd_per_hour, 0) > 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '${GROUP} machines without a machine rate: %', bad; END IF;
  SELECT array_agg(location || ': ' || machine_name ORDER BY location, machine_name) INTO bad FROM mhr_records
   WHERE process_group = ${sqlStr(GROUP)} AND location IN ('USA', 'India') AND machine_class LIKE 'sheet_roll_forming_%'
     AND machine_class <> ${sqlStr(classOf('Coil Material Stock'))} AND NOT COALESCE(usd_labor_rate_per_hr, 0) > 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '${GROUP} machines without labour: %', bad; END IF;
  -- A USA row whose rate someone changed after migration 862 keeps it: say which.
  SELECT array_agg(machine_name ORDER BY machine_name) INTO kept FROM mhr_records
   WHERE process_group = ${sqlStr(GROUP)} AND location = 'USA' AND machine_class LIKE 'sheet_roll_forming_%' AND specs ->> 'rate_basis' IS NULL;
  IF kept IS NOT NULL THEN RAISE NOTICE '${GROUP} USA machines keeping a rate set in HR Rates: %', kept; END IF;
END $roll_forming_check$;

NOTIFY pgrst, 'reload schema';
`;
writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${usa.length} USA machines rated, ${twins.length} India twins; default mill USA ${mill.direct} + ${mill.indirect} + ${mill.labour}, India ${millIndia.direct} + ${millIndia.indirect} + ${millIndia.labour.toFixed(2)})`);
