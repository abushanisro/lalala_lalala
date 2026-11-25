/**
 * Writes migration 1133 (PCB assembly: the SMT line and through-hole machines at USA and India rates, the sourced assembly reference, and
 * the PCB catalog's assembly processes) from memory/PCBA/Assembly:
 *   node scripts/generate-pcba-assembly-migration.js
 *
 * memory/PCBA prices bare-board fabrication only. The assembly data was researched and sourced (user decision 2026-11-23, every row with its
 * source_url, source_date and source_note) into memory/PCBA/Assembly:
 *   smt_machines.csv      the line and test machines with their list price, size and power (no overhead rates: none were published)
 *   smt_placement_rates   the placers' rated speed; reflow_ovens their conveyor speed range
 *   assembly_rates.csv    process rates and times (print, SPI, AOI, insertion, soldering, test, depanel, changeover, placement derating)
 *   assembly_costs.csv    stencils, solder paste and test tooling, by region and currency
 *
 * Machine rates. The reference prices a machine's hour with one rule per country: its direct overhead is linear in the machine's price and
 * power, its indirect overhead linear in its floor area (machine length x width x footprint allowance). The rule is fitted here from the
 * reference's own PCB machines (memory/PCBA/Machine for the USA, memory/Countries data/India_XML_Data_.csv commodity PCB for India) and must
 * reproduce every one of them to the cent, or nothing is written. The SMT machines are then priced by that same rule, with the reference's
 * economics (life 10 yr, uptime 80 %, installation 20 %, maintenance 5 %), so an assembly hour costs what a fabrication hour of the same price,
 * power and size costs.
 *
 * Crew, setup and wage grade: memory states none for an SMT machine. Each takes those of the reference's analogous fabrication machine
 * (ANALOG below: the stencil printer is a screen printer, the reflow oven a conveyor dryer, the SPI an in-line vision inspection...), the
 * analog's smallest crew when its machines differ.
 *
 * Listings: a machine is priced on its new list price, as the reference's machines are; a used listing is left out. A listing given as a
 * price range (two rows, "listing price low" and "high") is one machine at the midpoint (user decision 2026-11-24). A machine with no price,
 * and the loaders and conveyors (no process of their own), are not seeded.
 */
const { writeFileSync } = require('fs');
const { join } = require('path');
const { readCsv, buildMachineRows, insertSql, twinMachinesSql } = require('../migrations/scripts/lib/memory-machine-seed.js');
const { pcbaAssemblyMachines, ASSEMBLY } = require('./lib/pcba-assembly-machines.js');

const MEMORY = join(__dirname, '../../memory');
const OUT = join(__dirname, '../migrations/1133_pcba_assembly_machines_and_reference.sql');
const SOURCE_VERSION = '2026-PCB';

const { PROCESSES, BENCH, INDIA_LABOUR, ECONOMICS, RULE, machines, skipped, sayRule, r2 } = pcbaAssemblyMachines(MEMORY);
const q = (s) => `$str$${s}$str$`;
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return String(v ?? '').trim() === '' || !Number.isFinite(n) ? null : n; };

// Rows in the shape of the reference's machine files, so the shared seed builds them as it builds every family's machines.
const table = (p) => {
  const rows = machines.filter((m) => m.p === p).map((m) => ({
    Name: m.name, Description: `${p.process}: ${m.name}`,
    'Labor Rate (USD / hr)': p.usaLabour, 'Direct Overhead Rate (USD / hr)': m.usa.direct, 'Indirect Overhead Rate (USD / hr)': m.usa.indirect,
    'Number of Operators': p.operators, 'Labor Time Standard': 1, 'Wage Grade Name': p.grade, 'Work Center Labor Rate Factor': 1,
    'Setup Time (hr)': p.setup, 'Avg Utilization': 1, 'Good Part Yield': 1, 'Machine Price (USD)': m.price,
    'Machine Length (mm)': m.length, 'Machine Width (mm)': m.width, 'Machine Power (kW)': m.kw, 'Salvage Value Factor (%)': 0, 'Supplies Cost (USD / yr)': 0,
    ...ECONOMICS, ...Object.fromEntries(Object.entries(m.specs).map(([k, v]) => [k, v])),
  }));
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))) };
};
const built = buildMachineRows(PROCESSES.map((p) => ({
  table: table(p), rel: `${ASSEMBLY}/smt_machines.csv`, category: p.process, machineClass: p.cls, grade: p.grade, envelope: [null, null, null, null],
})), 'PCB');
const twins = machines.map((m) => ({
  machineClass: m.p.cls, machineName: m.name, location: 'India', countryCode: 'IN', labour: INDIA_LABOUR[m.p.grade],
  direct: m.india.direct, indirect: m.india.indirect, sourceKey: `${m.p.process}:${m.name}:India`,
}));

// ── The sourced tables ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TABLES = [
  { name: 'assembly_rates', file: `${ASSEMBLY}/assembly_rates.csv`, what: 'print, SPI and AOI speeds, THT insertion and soldering, test times, depanel speed, line changeover, placement derating' },
  { name: 'assembly_costs', file: `${ASSEMBLY}/assembly_costs.csv`, what: 'stencils, solder paste and its density, the stencil thickness, test fixtures and programs, by region and currency' },
];
const staged = TABLES.map((t) => {
  const { columns, rows } = readCsv(join(MEMORY, t.file));
  for (const c of ['item_key', 'value_min', 'value_max', 'unit', 'source_url', 'source_date']) if (!columns.includes(c)) throw new Error(`${t.file}: no ${c} column`);
  for (const r of rows) {
    if (!/^https?:\/\//.test(String(r.source_url ?? ''))) throw new Error(`${t.file}: a row without a source_url`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.source_date ?? ''))) throw new Error(`${t.file}: a row without an ISO source_date`);
    if (num(r.value_min) == null || num(r.value_max) == null || num(r.value_max) < num(r.value_min)) throw new Error(`${t.file}: ${r.item_key || r.item || r.operation}: value_min/value_max`);
  }
  return { ...t, rows: rows.length, keyed: rows.filter((r) => r.item_key).length, raw: { table_name: t.name, source_files: [t.file], status: 'COMPLETE', columns, rows } };
});

// ── The catalog processes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const CATALOG = [...PROCESSES, ...BENCH].map((p, i) => ({ ...p, order: 1133 + i }));
const defaultMachine = (p) => machines.find((m) => m.p.cls === p.cls)?.name ?? null;

const byClass = (cls) => machines.filter((m) => m.p.cls === cls);
const sql = `-- ============================================================================
-- Migration 1133: PCB assembly -- the SMT line and through-hole machines (USA, India), the sourced assembly reference, the catalog processes
-- ============================================================================
-- Generated by scripts/generate-pcba-assembly-migration.js; re-run it and diff instead of editing.
--
-- A board with components was priced as a bare board: memory/PCBA covers fabrication only and the PCB catalog had no assembly process.
-- The assembly data was researched and sourced into memory/PCBA/Assembly (user decision 2026-11-23: every row carries its source).
--
-- 1. Machines (mhr_records, process group PCB). ${machines.length} machines, each at USA and India rates:
${PROCESSES.map((p) => `--      ${p.process.padEnd(24)}${p.cls.padEnd(30)}${String(byClass(p.cls).length).padStart(2)}: ${byClass(p.cls).map((m) => m.name).join('; ')}`).join('\n')}
--    Rates: the reference's own overhead rule per country, fitted on its PCB machines and reproducing each to the cent (${RULE.USA.n} USA rows,
--    worst ${RULE.USA.worst.toFixed(4)}; ${RULE.India.n} India rows, worst ${RULE.India.worst.toFixed(4)} USD/hr), on the machine's price, power and floor area:
--      USA    ${sayRule(RULE.USA)}
--      India  ${sayRule(RULE.India)}
--    with the reference's economics (life 10 yr, uptime 80 %, installation 20 %, maintenance 5 %). A machine with no power or size stated has
--    no energy or floor area in its rate (said in its specs).
--    Crew, setup and wage grade: the reference's analogous fabrication machine (memory/PCBA/Machine), its smallest crew:
${PROCESSES.map((p) => `--      ${p.process.padEnd(24)}as ${p.analog.padEnd(30)}${String(p.operators).padStart(4)} operator(s), setup ${p.line ? '0 h (the line changeover)' : `${p.setup} h`}, ${p.grade} (USA ${p.usaLabour.toFixed(2)}, India ${INDIA_LABOUR[p.grade].toFixed(2)} USD/hr)`).join('\n')}
--    Prices: the new list price; a listing given as a range is one machine at its midpoint (user decision 2026-11-24).
--    Not seeded: used listings (${skipped.used.length}: ${skipped.used.join('; ')});
--      no price (${skipped.unpriced.length}: ${skipped.unpriced.join('; ')});
--      loaders and conveyors, which have no process of their own (${skipped.other.length}).
--    Placers carry their rated and IPC-9850 speed (specs.rated_cph, ipc_cph); reflow ovens their conveyor speed range (specs).
--    THT insertion and hand soldering are bench work on the PCB benches HR Rates holds (pcb_bench_operation, migrations 797 and 1129).
-- 2. The sourced assembly reference, staged whole as lookup tables of source version ${SOURCE_VERSION} (beside migration 1130's):
${staged.map((t) => `--      ${t.name.padEnd(16)}${String(t.rows).padStart(4)} rows (${t.keyed} keyed)  memory/${t.file}: ${t.what}`).join('\n')}
-- 3. The PCB catalog's assembly processes (process_taxonomy, process_calculator_mappings), each with its machine class; the calculators of
--    migration 1134 activate them.
--
-- Idempotent: a machine already present for its class, location and name is skipped; a staged table is left as it is; a catalog row keeps
-- its machine class and wiring.
-- Verify: SELECT location, machine_class, count(*) FROM mhr_records WHERE machine_class LIKE 'pcba_%' GROUP BY 1, 2 ORDER BY 1, 2;
--   -- expect ${machines.length} USA and ${machines.length} India rows.
-- ============================================================================

${insertSql(built.columns, built.rows)}

${twinMachinesSql({ tag: 'pcba_india', processGroup: 'PCB', twins })}

INSERT INTO machining_reference_data (category, source_region, source_version, key, value, unit_type, notes, raw) VALUES
${staged.map((t) => `  ($str$lookup_table$str$, 'USA', ${q(SOURCE_VERSION)}, ${q(t.name)}, ${q(String(t.rows))}, NULL, ${q(`Staged from memory/${t.file} (researched, sourced: user decision 2026-11-23)`)}, $jsonb$${JSON.stringify(t.raw)}$jsonb$::jsonb)`).join(',\n')}
ON CONFLICT (category, source_region, source_version, key) DO NOTHING;

INSERT INTO process_taxonomy (process_group, process_name, machine_class, roadmap_status, default_machine_name, default_tool_shop_name, display_order)
VALUES
${CATALOG.map((p) => `(${q('PCB')}, ${q(p.process)}, ${q(p.cls)}, 'not_modeled', ${p.cls === 'pcb_bench_operation' ? 'NULL' : q(defaultMachine(p))}, NULL, ${p.order})`).join(',\n')}
ON CONFLICT (process_group, process_name) DO UPDATE
SET machine_class = COALESCE(process_taxonomy.machine_class, EXCLUDED.machine_class),
    default_machine_name = COALESCE(process_taxonomy.default_machine_name, EXCLUDED.default_machine_name);

INSERT INTO process_calculator_mappings (process_group, process_route, operation, calculator_id, calculator_name, is_active, display_order, machine_class, canonical_process_id)
SELECT v.grp, v.name, v.name, NULL, NULL, false, v.display_order, v.machine_class, pt.id
FROM process_taxonomy pt
JOIN (VALUES
${CATALOG.map((p) => `(${q('PCB')}, ${q(p.process)}, ${q(p.cls)}, ${p.order})`).join(',\n')}
) AS v(grp, name, machine_class, display_order)
  ON pt.process_group = v.grp AND pt.process_name = v.name
WHERE NOT EXISTS (SELECT 1 FROM process_calculator_mappings m WHERE m.process_group = v.grp AND m.operation = v.name)
ON CONFLICT (process_group, process_route, operation) DO NOTHING;

DO $pcba_check$
DECLARE usa integer; india integer; catalog integer;
BEGIN
  SELECT count(*) FILTER (WHERE location = 'USA'), count(*) FILTER (WHERE location = 'India') INTO usa, india
  FROM mhr_records WHERE process_group = 'PCB' AND machine_class LIKE 'pcba_%';
  SELECT count(*) INTO catalog FROM process_calculator_mappings WHERE process_group = 'PCB' AND operation IN (${CATALOG.map((p) => q(p.process)).join(', ')});
  IF usa < ${machines.length} OR india < ${machines.length} OR catalog < ${CATALOG.length} THEN
    RAISE EXCEPTION 'PCB assembly: % USA and % India machines (expected ${machines.length} each), % catalog rows (expected ${CATALOG.length})', usa, india, catalog;
  END IF;
END $pcba_check$;

NOTIFY pgrst, 'reload schema';
`;
writeFileSync(OUT, sql);
console.log(`wrote ${OUT}: ${machines.length} machines x 2 locations, ${staged.map((t) => `${t.name} ${t.rows}`).join(', ')}, ${CATALOG.length} catalog processes`);
console.log(`  ${RULE.USA.label}: ${sayRule(RULE.USA)} (n ${RULE.USA.n}, worst ${RULE.USA.worst.toFixed(4)})`);
console.log(`  ${RULE.India.label}: ${sayRule(RULE.India)} (n ${RULE.India.n}, worst ${RULE.India.worst.toFixed(4)})`);
for (const m of machines) console.log(`  ${m.p.cls.padEnd(30)} ${m.name.padEnd(44)} ${String(m.price).padStart(8)} USA ${r2(m.usa.direct + m.usa.indirect)} + ${m.p.usaLabour}x${m.p.operators}  India ${r2(m.india.direct + m.india.indirect)} + ${INDIA_LABOUR[m.p.grade]}x${m.p.operators}`);
