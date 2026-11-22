#!/usr/bin/env node
/**
 * Writes migration 1114 (what Stock Machining's cost engine still lacks of memory/Stock Maching: the rest of its reference tables, its
 * processes and operations, the Material Stock machine, and the machine classes of its two catalog rows):
 *   node scripts/generate-stock-machining-reference-migration.js
 * Re-run and diff instead of editing the migration.
 */
const { readdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { readCsv, sqlStr, sqlNum, sqlJsonb } = require('../migrations/scripts/lib/memory-machine-seed.js');

const MEMORY = join(__dirname, '../../memory');
const DIR = 'Stock Maching';
const COUNTRIES = 'Countries data';
const OUT = join(__dirname, '../migrations/1114_stock_machining_reference.sql');
const GROUP = 'Stock Machining';
// The source version migration 816 staged the group's variables, wage grades and band saw tables under.
const VERSION = '2026-Stock-Machining';
const BAND_SAW_CLASS = 'band_saw'; // migration 815
const STOCK_CLASS = 'stock_machining_material_stock';
const STOCK_MACHINE = 'Default Material Stock';

/** A number as a file writes it: plain, or "$ 56.26" / "$ -" (the Canada, China, Mexico and Singapore exports). */
const num = (v, what) => {
  const s = String(v ?? '').replace(/[$\s,]/g, '');
  if (s === '-') return 0;
  if (s === '' || !Number.isFinite(Number(s))) throw new Error(`not a number: ${what} = "${v}"`);
  return Number(s);
};
const same = (a, b) => Math.abs(a - b) < 5e-4;

// ── Lookup tables ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The preferred stock sizes: memory/Stock Maching holds a cut-down export of the table (its file is named _PARTIAL: the sizes between
// 1041 and 4369 mm are missing), memory/Multi-Spindle Maching the whole of it. Every row of the partial export is in the whole table
// (checked here), so the whole table is what is staged: a stock size is never chosen from a table with a gap in it.
const wholeSizes = readCsv(join(MEMORY, 'Multi-Spindle Maching/lookup/tblPreferredSizes.csv')).rows
  .map((r) => ({ sizeMm: num(r.sizeMm, 'sizeMm'), unitSystem: String(r.unitSystem), comment: r.comment == null ? null : String(r.comment) }));
const partialSizes = readCsv(join(MEMORY, DIR, 'lookup/tblPreferredSizes_PARTIAL.csv')).rows
  .map((r) => ({ sizeMm: num(r['Size (mm)'], 'Size (mm)'), unitSystem: String(r['Unit System']) }));
const sizeKey = (r) => `${r.unitSystem}|${r.sizeMm.toFixed(4)}`;
const wholeKeys = new Set(wholeSizes.map(sizeKey));
const stray = partialSizes.filter((r) => !wholeKeys.has(sizeKey(r)));
if (stray.length) throw new Error(`tblPreferredSizes_PARTIAL lists sizes the whole table does not: ${stray.slice(0, 5).map(sizeKey).join(', ')}`);
if (new Set(wholeSizes.map((r) => r.unitSystem)).size !== 3) throw new Error('tblPreferredSizes: expected the unit systems US, metric and both');

// The parting ring widths are the same table in both folders (checked): staged with the keys the Multi-Spindle copy has (migration 787).
const ringsOf = (rows, d, w) => rows.map((r) => ({ diameterMm: num(r[d], d), ringWidthMm: num(r[w], w) }));
const rings = ringsOf(readCsv(join(MEMORY, DIR, 'lookup/tblPartingRingWidth.csv')).rows, 'Diameter (mm)', 'Ring Width (mm)');
const ringsWhole = ringsOf(readCsv(join(MEMORY, 'Multi-Spindle Maching/lookup/tblPartingRingWidth.csv')).rows, 'diameterMm', 'ringWidthMm');
if (JSON.stringify(rings) !== JSON.stringify(ringsWhole)) throw new Error('tblPartingRingWidth differs between memory/Stock Maching and memory/Multi-Spindle Maching');

const csvTable = (file) => readCsv(join(MEMORY, DIR, 'lookup', file));
const spacing = csvTable('tblPartSpacing.csv');
const controls = csvTable('validationDisplayControls.csv');

const lookups = [
  { name: 'tblPreferredSizes', files: ['Multi-Spindle Maching/lookup/tblPreferredSizes.csv'], columns: ['sizeMm', 'unitSystem', 'comment'], rows: wholeSizes,
    note: `memory/Multi-Spindle Maching/lookup/tblPreferredSizes.csv, the whole table (memory/${DIR}/lookup/tblPreferredSizes_PARTIAL.csv is ${partialSizes.length} of its ${wholeSizes.length} rows)` },
  { name: 'tblPartingRingWidth', files: [`${DIR}/lookup/tblPartingRingWidth.csv`], columns: ['diameterMm', 'ringWidthMm'], rows: rings,
    note: `memory/${DIR}/lookup/tblPartingRingWidth.csv` },
  { name: 'tblPartSpacing', files: [`${DIR}/lookup/tblPartSpacing.csv`], columns: spacing.columns, rows: spacing.rows, note: `memory/${DIR}/lookup/tblPartSpacing.csv` },
  { name: 'validationDisplayControls', files: [`${DIR}/lookup/validationDisplayControls.csv`], columns: controls.columns, rows: controls.rows,
    note: `memory/${DIR}/lookup/validationDisplayControls.csv` },
];

// ── Processes and operations ────────────────────────────────────────────────────────────────────────────────────────────────────────
const processes = readCsv(join(MEMORY, DIR, 'processes.csv')).rows;
const operations = readCsv(join(MEMORY, DIR, 'operations.csv')).rows;
const grades = Object.fromEntries(readCsv(join(MEMORY, DIR, 'wage_grade_associations (3).csv')).rows.map((r) => [r['Process Name'], r['Wage Grade Name']]));
const processNames = processes.map((p) => String(p['Process Name']));
if (JSON.stringify(processNames) !== JSON.stringify(['Band Saw', 'Material Stock', 'User-Defined Process'])) throw new Error(`unexpected processes: ${processNames.join(', ')}`);
for (const o of operations) {
  if (!processNames.includes(String(o['Process Name']).split(':')[0])) throw new Error(`operation of an unknown process: ${o['Process Name']}`);
}

const staged = [
  ...lookups.map((l) => ['lookup_table', l.name, String(l.rows.length), null, `Staged from ${l.note}`,
    { table_name: l.name, source_files: l.files, status: 'COMPLETE', columns: l.columns, rows: l.rows }]),
  ...processes.map((p) => ['process', String(p['Process Name']), p['Default Machine'], null, null, p]),
  ...operations.map((o) => ['operation', String(o['Process Name']), null, null, null, o]),
];
const stagedRow = ([category, key, value, unit, notes, raw]) =>
  `  (${sqlStr(category)}, 'USA', ${sqlStr(VERSION)}, ${sqlStr(key)}, ${sqlStr(value)}, ${sqlStr(unit)}, ${sqlStr(notes)}, ${sqlJsonb(raw)})`;

// ── The Material Stock machine ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The stock as supplied: no operator, no rate. One machine, in the reference file and in every country's export.
const stockFile = readCsv(join(MEMORY, DIR, 'Machine/machines_material_stock.csv')).rows;
if (stockFile.length !== 1 || stockFile[0].Name !== STOCK_MACHINE) throw new Error('machines_material_stock.csv: expected the one Default Material Stock machine');
const stock = stockFile[0];
for (const c of ['Labor Rate (USD / hr)', 'Direct Overhead Rate (USD / hr)', 'Indirect Overhead Rate (USD / hr)', 'Number of Operators', 'Setup Time (hr)']) {
  if (num(stock[c], c) !== 0) throw new Error(`${STOCK_MACHINE}: ${c} is ${stock[c]}, expected 0 (the stock as supplied)`);
}
if (grades['Material Stock'] !== '0 - Metal' || grades['Band Saw'] !== '2 - Metal') throw new Error('unexpected wage grades for Material Stock / Band Saw');

// Every export lists the group's 14 machines (13 band saws and the stock); the saws' own data is the reference file's in each of them.
const sawFile = readCsv(join(MEMORY, DIR, 'Machine/machines_band_saw.csv')).rows;
const SAW_COLUMNS = { setupTime: 'Setup Time (hr)', axialFeedRate: 'Axial Feed Rate (mm / s)', loadTime: 'Load+Unload Time (s)', unloadTime: 'Unload Time (s)',
  maxCutAngle: 'Max Cut Angle (deg)', maxStockDiameter: 'Max Stock Diameter (mm)', maxStockHeight: 'Max Stock Height (mm)', maxStockWidth: 'Max Stock Width (mm)' };
const exportFiles = readdirSync(join(MEMORY, COUNTRIES)).filter((f) => f.endsWith('.csv')).sort();
for (const file of exportFiles) {
  const t = readCsv(join(MEMORY, COUNTRIES, file));
  const col = (name) => t.columns.find((c) => c.trim() === name);
  const rows = t.rows.filter((r) => String(r[col('Commodity')]).trim() === GROUP);
  const names = (type) => rows.filter((r) => String(r[col('Machine Type')]).trim() === type).map((r) => String(r[col('name')]).trim()).sort();
  if (JSON.stringify(names('Band Saw')) !== JSON.stringify(sawFile.map((m) => String(m.Name)).sort())) throw new Error(`${file}: its ${GROUP} band saws are not the reference file's`);
  if (JSON.stringify(names('Material Stock')) !== JSON.stringify([STOCK_MACHINE])) throw new Error(`${file}: expected the one ${STOCK_MACHINE}`);
  for (const m of sawFile) {
    const r = rows.find((x) => String(x[col('name')]).trim() === m.Name);
    for (const [exp, ref] of Object.entries(SAW_COLUMNS)) {
      if (!same(num(r[col(exp)], `${file} ${m.Name} ${exp}`), num(m[ref], ref))) throw new Error(`${file} ${m.Name}: ${exp} ${r[col(exp)]} differs from the reference file's ${m[ref]}`);
    }
  }
  const s = rows.find((x) => String(x[col('name')]).trim() === STOCK_MACHINE);
  for (const c of ['customWorkCenterDirectOverheadRate', 'customWorkCenterIndirectOverheadRate', 'numOperators', 'setupTime']) {
    if (num(s[col(c)], `${file} ${STOCK_MACHINE} ${c}`) !== 0) throw new Error(`${file} ${STOCK_MACHINE}: ${c} is not 0`);
  }
}

const stockSpecs = {
  source: `memory/${DIR}/Machine/machines_material_stock.csv`,
  standard_stock_length_mm: num(stock['Standard Stock Length (mm)'], 'Standard Stock Length (mm)'),
  is_preferred: stock['Is Preferred'] === true,
  overhead_multiplier: num(stock['Overhead Multiplier'], 'Overhead Multiplier'),
  data_source: stock['Data Source'],
};
const stockRow = (location, country, basis) => `  (${[
  sqlStr(STOCK_CLASS), sqlStr(location), sqlStr(STOCK_MACHINE), sqlStr('USD'), sqlStr(country), sqlStr('BENCHMARK'), sqlStr(GROUP),
  0, 0, 0, 0, sqlNum(stock['Work Center Labor Rate Factor']), sqlNum(stock['Labor Time Standard']), sqlStr(grades['Material Stock']),
  sqlNum(stock['Avg Utilization']), sqlNum(stock['Good Part Yield']), sqlStr(stock['Machine Manufacturer Location']),
  sqlJsonb({ ...stockSpecs, rate_basis: basis }), sqlStr(`Material Stock:${STOCK_MACHINE}${location === 'USA' ? '' : `:${location}`}`),
].join(', ')})`;

const sql = `-- ============================================================================
-- Migration 1114: the rest of Stock Machining's reference data
-- ============================================================================
-- Generated by scripts/generate-stock-machining-reference-migration.js; re-run it and diff instead of editing.
--
-- Stock Machining is being costed (user decision 2026-11-22): the raw stock a machined part is cut from is chosen, sized, sawn to length
-- and priced from memory/${DIR}. Migrations 790, 815 and 816 seeded its two catalog rows, its 13 band saws and its variables, wage
-- grades and band saw tables. What a cost engine also reads was left in the files:
--
-- 1. Staged under source version ${VERSION} (as 816, lossless):
${lookups.map((l) => `--      ${l.name.padEnd(26)}${String(l.rows.length).padStart(4)} rows  ${l.note}`).join('\n')}
--      the ${processes.length} processes (processes.csv) and the ${operations.length} operations (operations.csv: ${operations.map((o) => o['Process Name']).join('; ')}).
--    tblPreferredSizes is the whole table: the copy in memory/${DIR} is a cut-down export of it (every one of its rows is in the whole
--    table; the sizes from 1041 to 4369 mm are absent from it), and a stock size is never chosen from a table with a gap.
-- 2. The Material Stock machine "${STOCK_MACHINE}" (memory/${DIR}/Machine/machines_material_stock.csv; class ${STOCK_CLASS},
--    wage grade ${grades['Material Stock']}): the stock as supplied, no operator and no rate, standard stock length ${stockSpecs.standard_stock_length_mm} mm. USA, and India (the
--    ${exportFiles.length} exports of memory/${COUNTRIES} all list it, at no rate).
-- 3. process_taxonomy: the machine classes of the two catalog rows (Band Saw -> ${BAND_SAW_CLASS}, Material Stock -> ${STOCK_CLASS}), so a
--    process finds its machines; and the group's third process, User-Defined Process (no machine, no wage grade: a step the engineer adds).
--
-- Not changed: the band saws' rates (815 and the India twins hold the reference file's and the India export's; the ${exportFiles.length} exports list the
-- same 13 saws with the reference file's own data: setup, feed rate, load and unload times, stock limits; checked when this file is
-- generated) and the stock prices by form (material_stock_prices holds all six forms of the file's 105 materials for the USA).
--
-- Idempotent. Verify:
--   SELECT category, count(*) FROM machining_reference_data WHERE source_version = '${VERSION}' GROUP BY 1 ORDER BY 1;
--   SELECT location, machine_class, count(*) FROM mhr_records WHERE process_group = '${GROUP}' GROUP BY 1, 2 ORDER BY 1, 2;
-- ============================================================================

INSERT INTO machining_reference_data (category, source_region, source_version, key, value, unit_type, notes, raw) VALUES
${staged.map(stagedRow).join(',\n')}
ON CONFLICT (category, source_region, source_version, key) DO NOTHING;

INSERT INTO mhr_records (
  machine_class, location, machine_name, currency_code, country_code, source_type, process_group,
  operators, setup_time_hr, direct_overhead_rate, indirect_overhead_rate, benchmark_direct_overhead_rate_usd_hr, benchmark_indirect_overhead_rate_usd_hr,
  total_machine_hour_rate, mhr_usd_per_hour, usd_labor_rate_per_hr, benchmark_labor_rate_usd_hr, usd_lhr_total,
  work_center_labor_rate_factor, labor_time_standard, wage_grade, avg_utilization, good_part_yield, manufacturer_country, specs, benchmark_source_key
)
SELECT v.machine_class, v.location, v.machine_name, v.currency_code, v.country_code, v.source_type, v.process_group,
  v.operators::numeric, v.setup_time_hr::numeric, v.rate::numeric, v.rate::numeric, v.rate::numeric, v.rate::numeric,
  v.rate::numeric, v.rate::numeric, v.labour::numeric, v.labour::numeric, v.labour::numeric,
  v.wclrf::numeric, v.lts::numeric, v.wage_grade, v.util::numeric, v.yield::numeric, v.manufacturer_country, v.specs::jsonb, v.source_key
FROM (VALUES
${stockRow('USA', 'US', `memory/${DIR}/Machine/machines_material_stock.csv: the stock as supplied, no rate`)},
${stockRow('India', 'IN', `memory/${COUNTRIES}/India_XML_Data_.csv: the stock as supplied, no rate`)}
) AS v(machine_class, location, machine_name, currency_code, country_code, source_type, process_group, operators, setup_time_hr, rate, labour,
  wclrf, lts, wage_grade, util, yield, manufacturer_country, specs, source_key)
WHERE NOT EXISTS (
  SELECT 1 FROM mhr_records m WHERE m.machine_class = v.machine_class AND m.location = v.location AND lower(trim(m.machine_name)) = lower(trim(v.machine_name))
);

UPDATE process_taxonomy t SET machine_class = v.machine_class
FROM (VALUES ('Band Saw', ${sqlStr(BAND_SAW_CLASS)}), ('Material Stock', ${sqlStr(STOCK_CLASS)})) AS v(process_name, machine_class)
WHERE t.process_group = ${sqlStr(GROUP)} AND t.process_name = v.process_name AND t.machine_class IS DISTINCT FROM v.machine_class;

INSERT INTO process_taxonomy (process_group, process_name, roadmap_status, is_active, display_order, notes)
SELECT ${sqlStr(GROUP)}, 'User-Defined Process', 'non_mfg', true, 1502,
  'A step the engineer adds to a Stock Machining part by hand: no machine and no wage grade of its own (memory/${DIR}/processes.csv).'
WHERE NOT EXISTS (SELECT 1 FROM process_taxonomy WHERE process_group = ${sqlStr(GROUP)} AND process_name = 'User-Defined Process');

DO $stock_machining_check$
DECLARE n integer; bad text[];
BEGIN
  SELECT count(*) INTO n FROM machining_reference_data WHERE source_version = ${sqlStr(VERSION)} AND category = 'lookup_table'
    AND key IN (${lookups.map((l) => sqlStr(l.name)).join(', ')});
  IF n <> ${lookups.length} THEN RAISE EXCEPTION '${GROUP}: expected its ${lookups.length} lookup tables staged, found %', n; END IF;
  SELECT jsonb_array_length(raw -> 'rows') INTO n FROM machining_reference_data
   WHERE source_version = ${sqlStr(VERSION)} AND category = 'lookup_table' AND key = 'tblPreferredSizes';
  IF n < ${wholeSizes.length} THEN RAISE EXCEPTION '${GROUP}: tblPreferredSizes holds % sizes, the whole table has ${wholeSizes.length}', n; END IF;
  SELECT count(*) INTO n FROM machining_reference_data WHERE source_version = ${sqlStr(VERSION)} AND category IN ('process', 'operation');
  IF n <> ${processes.length + operations.length} THEN RAISE EXCEPTION '${GROUP}: expected ${processes.length} processes and ${operations.length} operations staged, found %', n; END IF;
  SELECT count(*) INTO n FROM mhr_records WHERE process_group = ${sqlStr(GROUP)} AND machine_class = ${sqlStr(STOCK_CLASS)} AND location IN ('USA', 'India');
  IF n <> 2 THEN RAISE EXCEPTION '${GROUP}: expected ${STOCK_MACHINE} in USA and India, found % row(s)', n; END IF;
  -- A catalog row of the group without its machine class: its process would find no machine.
  SELECT array_agg(process_name ORDER BY process_name) INTO bad FROM process_taxonomy
   WHERE process_group = ${sqlStr(GROUP)} AND process_name IN ('Band Saw', 'Material Stock') AND machine_class IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '${GROUP} catalog rows without a machine class: %', bad; END IF;
  -- The saws themselves are migration 815's and the India twins': say what a process will find.
  SELECT count(*) INTO n FROM mhr_records WHERE machine_class = ${sqlStr(BAND_SAW_CLASS)} AND location IN ('USA', 'India') AND COALESCE(mhr_usd_per_hour, 0) > 0;
  RAISE NOTICE '${GROUP}: % rated band saws in USA and India (${sawFile.length} in each when migration 815 and the India twins are applied)', n;
END $stock_machining_check$;

NOTIFY pgrst, 'reload schema';
`;
writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${lookups.map((l) => `${l.name} ${l.rows.length}`).join(', ')}; ${processes.length} processes, ${operations.length} operations; ${STOCK_MACHINE} USA + India; ${exportFiles.length} exports checked)`);
