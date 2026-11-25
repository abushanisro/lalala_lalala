/**
 * Writes migration 1129 (the PCB fabrication machines at India rates, and the machine classes of the PCB catalog rows) from memory:
 *   node scripts/generate-pcb-machines-migration.js
 * Each India row is its USA twin (migration 797, same machine class and exact name) with the India direct and indirect overhead rates of the
 * export (memory/Countries data/India_XML_Data_.csv, commodity PCB) and the India rate of its process's wage grade
 * (memory/PCBA/wage_grade_associations (4).csv). The catalog rows of process_taxonomy and process_calculator_mappings (migration 790) get the
 * machine class migration 797 gave each process, so the PCB calculators can activate them.
 */
const { writeFileSync } = require('fs');
const { join } = require('path');
const { readCsv } = require('../migrations/scripts/lib/memory-machine-seed.js');

const MEMORY = join(__dirname, '../../memory');
const OUT = join(__dirname, '../migrations/1129_pcb_machines_india_and_classes.sql');

// The machine class migration 797 gave each PCB process (memory/PCBA/processes.csv). No Cost Feature and User-Defined Process have no machine.
const CLASS = {
  'Apply Photo Resist': 'apply_photo_resist',
  'Automated Optical Inspection': 'automated_optical_inspection',
  'Automated Vision Inspection': 'automated_vision_inspection',
  'Bed of Nails': 'bed_of_nails',
  'Bench Operation': 'pcb_bench_operation',
  'Copper Plate and Tin Coat': 'copper_plate_and_tin_coat',
  'Cure Plugged Vias': 'cure_plugged_vias',
  'Cure Solder Mask': 'cure_solder_mask',
  DES: 'pcb_des',
  'Desmear and Plate Through Holes': 'desmear_and_plate_through_holes',
  'Develop Solder Mask': 'develop_solder_mask',
  'Dissolve Unexposed Photo Resist': 'dissolve_unexposed_photo_resist',
  'Drill Circuit Holes': 'drill_circuit_holes',
  'Drill Registration Holes': 'drill_registration_holes',
  'Electroless Nickel Immersion Gold': 'electroless_nickel_immersion_gold',
  'Film Imaging': 'film_imaging',
  'Flying Probe': 'flying_probe',
  'Hot Air Solder Leveling': 'hot_air_solder_leveling',
  'Laser Drill Vias': 'laser_drill_vias',
  'Material Stock': 'material_stock',
  'Organic Solderability Preservative': 'organic_solderability_preservative',
  'Oven Cure Layers': 'oven_cure_layers',
  Photolithography: 'photolithography',
  'Plug Vias': 'plug_vias',
  Router: 'pcb_router',
  SES: 'pcb_ses',
  'Screen Printing': 'screen_printing',
  'Silkscreen Cure': 'silkscreen_cure',
  Stamp: 'pcb_stamp',
  'Surface Preparation': 'surface_preparation',
  'Tack Dry Solder Mask': 'tack_dry_solder_mask',
  'Wet Film Solder Mask': 'wet_film_solder_mask',
};
// Machine types the India export still carries from an older split of the plating lines. memory/PCBA/processes.csv has no such process and the
// USA seed has no such class: their lines are the same machines as Copper Plate and Tin Coat / Desmear and Plate Through Holes, which are copied.
const LEGACY_TYPES = new Set(['Copper Plate', 'Tin Coat', 'Desmear', 'Plate Through Holes']);
// The India export spells one machine differently from the USA seed (memory/PCBA/Machine): the India row is the USA machine of this name.
const USA_NAME = { 'Tamprinter PCB Drying Oven': 'Tampprinter PCB Drying Oven' };
// India labour by wage grade (USD/hr): the rates the India rows of each grade carry in HR Rates
// (SELECT DISTINCT wage_grade, usd_labor_rate_per_hr FROM mhr_records WHERE location = 'India' AND wage_grade LIKE '% - Metal'):
// 3 - Metal 1.73, 4 - Metal 2.30 (also memory/database/Combined_All_Countries_Database.json, India). Material Stock (0 - Metal) carries none.
const INDIA_LABOUR = { '0 - Metal': 0, '3 - Metal': 1.73, '4 - Metal': 2.3 };

const grades = Object.fromEntries(readCsv(join(MEMORY, 'PCBA/wage_grade_associations (4).csv')).rows
  .filter((g) => CLASS[g['Process Name']]).map((g) => [g['Process Name'], g['Wage Grade Name']]));
for (const process of Object.keys(CLASS)) {
  if (!grades[process]) throw new Error(`${process}: no wage grade in memory/PCBA/wage_grade_associations (4).csv`);
  if (INDIA_LABOUR[grades[process]] == null) throw new Error(`${process}: no India rate for ${grades[process]}`);
}

const num = (v) => { const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const q = (s) => `$str$${s}$str$`;
const seen = new Set();
const skipped = {};
const india = [];
for (const r of readCsv(join(MEMORY, 'Countries data/India_XML_Data_.csv')).rows.filter((x) => x['Commodity'] === 'PCB')) {
  const process = r['Machine Type'];
  if (LEGACY_TYPES.has(process)) { skipped[process] = (skipped[process] ?? 0) + 1; continue; }
  const cls = CLASS[process];
  if (!cls) throw new Error(`no machine class for the India PCB machine type ${process}`);
  const name = USA_NAME[r['name']] ?? r['name'];
  const key = `${cls}|${name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  india.push({ cls, name, process, grade: grades[process], labour: INDIA_LABOUR[grades[process]], direct: num(r['customWorkCenterDirectOverheadRate']), indirect: num(r['customWorkCenterIndirectOverheadRate']) });
}
india.sort((a, b) => (a.cls + a.name).localeCompare(b.cls + b.name));
const byProcess = {};
for (const r of india) byProcess[r.process] = (byProcess[r.process] ?? 0) + 1;
const missingIndia = Object.keys(CLASS).filter((p) => !byProcess[p]);
if (missingIndia.length) throw new Error(`no India machine for: ${missingIndia.join(', ')}`);

const sql = `-- ============================================================================
-- Migration 1129: PCB fabrication machines at India rates; the PCB catalog rows get their machine classes
-- ============================================================================
-- Generated by scripts/generate-pcb-machines-migration.js; re-run it and diff instead of editing.
--
-- Migration 797 seeded the PCB fabrication machines for the USA only, so a board priced in India had no machine; and the PCB rows of
-- process_taxonomy and process_calculator_mappings (migration 790) carry no machine class, so no calculator can activate them.
--
-- 1. India twins. Source: memory/Countries data/India_XML_Data_.csv, commodity "PCB": each machine's direct and indirect overhead rate
--    (USD/hr, rounded to cents). Labour: the India rate of the process's wage grade (memory/PCBA/wage_grade_associations (4).csv), written to
--    usd_labor_rate_per_hr AND usd_lhr_total (the column the machine selector reads):
--      3 - Metal  1.73 USD/hr  and  4 - Metal  2.30 USD/hr: the rates the India rows of those grades carry in HR Rates
--      0 - Metal  0 (Material Stock, a virtual machine with no labour, as in the USA)
--    ${india.length} machines, each matched by machine class and exact name to its USA row:
${Object.entries(byProcess).sort().map(([p, n]) => `--      ${p.padEnd(36)}${n} machine(s)`).join('\n')}
--    Not copied: ${Object.entries(skipped).sort().map(([p, n]) => `${p} (${n})`).join(', ')}. The export still carries these types from an older
--    split of the plating lines; memory/PCBA/processes.csv has no such process and the USA seed no such class.
--    The export's "Tamprinter PCB Drying Oven" is the USA seed's "Tampprinter PCB Drying Oven" (same dryer, spelled differently).
-- 2. Machine classes: each PCB process's rows in process_taxonomy and process_calculator_mappings get the class migration 797 gave it.
--
-- Idempotent: an India row already present for its class and name is skipped; a class already set is left as it is.
-- Verify: SELECT location, count(DISTINCT machine_class || machine_name) FROM mhr_records WHERE process_group = 'PCB' GROUP BY 1;
--   -- expect India ${india.length}.
--   SELECT process_name, machine_class FROM process_taxonomy WHERE process_group = 'PCB' ORDER BY 1;  -- every process but No Cost Feature
-- ============================================================================

DO $pcb_machines$
DECLARE
  cols text; sel text; r record; usa_id uuid; n integer := 0; missing text[] := '{}';
BEGIN
  SELECT
    string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position),
    string_agg(
      CASE c.column_name
        WHEN 'location'                                THEN '$5'
        WHEN 'country_code'                            THEN '$6'
        WHEN 'direct_overhead_rate'                    THEN '$2'
        WHEN 'indirect_overhead_rate'                  THEN '$3'
        WHEN 'benchmark_direct_overhead_rate_usd_hr'   THEN '$2'
        WHEN 'benchmark_indirect_overhead_rate_usd_hr' THEN '$3'
        WHEN 'total_machine_hour_rate'                 THEN 'ROUND(($2 + $3)::numeric, 2)'
        WHEN 'mhr_usd_per_hour'                        THEN 'ROUND(($2 + $3)::numeric, 2)'
        WHEN 'usd_labor_rate_per_hr'                   THEN '$4'
        WHEN 'usd_lhr_total'                           THEN '$4'
        WHEN 'benchmark_labor_rate_usd_hr'             THEN '$4'
        WHEN 'benchmark_source_key'                    THEN '$7'
        WHEN 'id'                                      THEN 'gen_random_uuid()'
        WHEN 'created_at'                              THEN 'now()'
        WHEN 'updated_at'                              THEN 'now()'
        ELSE 'usa_row.' || quote_ident(c.column_name)
      END, ', ' ORDER BY c.ordinal_position
    )
  INTO cols, sel
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'mhr_records' AND c.is_generated = 'NEVER';

  -- (machine class, machine name, labour, direct, indirect, source key)
  FOR r IN SELECT * FROM (VALUES
${india.map((t) => `  (${q(t.cls)}, ${q(t.name)}, ${t.labour}, ${t.direct}, ${t.indirect}, ${q(`${t.process}:${t.name}:India`)})`).join(',\n')}
  ) AS v(machine_class, machine_name, labor, direct, indirect, source_key)
  LOOP
    -- The oldest USA row: a database where migration 797 ran twice holds two identical rows per machine.
    SELECT id INTO usa_id FROM mhr_records
    WHERE location = 'USA' AND process_group = 'PCB' AND machine_class = r.machine_class AND machine_name = r.machine_name
    ORDER BY created_at, id
    LIMIT 1;
    IF usa_id IS NULL THEN
      missing := array_append(missing, r.machine_class || ':' || r.machine_name);
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM mhr_records m WHERE m.location = 'India' AND m.machine_class = r.machine_class AND m.machine_name = r.machine_name) THEN
      CONTINUE;
    END IF;
    EXECUTE format('INSERT INTO mhr_records (%s) SELECT %s FROM mhr_records usa_row WHERE usa_row.id = $1', cols, sel)
      USING usa_id, r.direct, r.indirect, r.labor, 'India', 'IN', r.source_key;
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'PCB India rows inserted: %', n;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'PCB machines with no USA row (migration 797): %', missing;
  END IF;
END $pcb_machines$;

-- (process, machine class)
WITH v(process, machine_class) AS (VALUES
${Object.entries(CLASS).map(([p, c]) => `  (${q(p)}, ${q(c)})`).join(',\n')}
)
UPDATE public.process_taxonomy t
SET machine_class = v.machine_class
FROM v
WHERE t.process_group = 'PCB' AND t.process_name = v.process AND t.machine_class IS NULL;

WITH v(process, machine_class) AS (VALUES
${Object.entries(CLASS).map(([p, c]) => `  (${q(p)}, ${q(c)})`).join(',\n')}
)
UPDATE public.process_calculator_mappings m
SET machine_class = v.machine_class, updated_at = now()
FROM v
WHERE m.process_group = 'PCB' AND m.process_route = v.process AND m.operation = v.process AND m.machine_class IS NULL;

NOTIFY pgrst, 'reload schema';
`;
writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${india.length} India twins, ${Object.keys(CLASS).length} classes)`);
