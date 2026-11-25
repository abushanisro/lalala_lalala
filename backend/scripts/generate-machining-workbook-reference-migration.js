/**
 * Writes migration 1137 (the machining workbook's cutting data) from memory/machining/workbook/*.csv:
 *   node scripts/generate-machining-workbook-reference-migration.js
 *
 * The user's workbook memory/Machining - Calculator Database (1).xlsx times every cutting operation the same way: spindle speed from a
 * cutting speed, passes, the cut length plus an approach allowance over the feed, rounded up to whole seconds per use. Its cutting
 * speeds and feeds are tables on the sheets (extracted by scripts/extract-machining-workbook-tables.js) and pictures pasted into them
 * (the Uddeholm Corrax tables, written by hand with their source). Each CSV is staged whole as one lookup_table row of
 * machining_reference_data, the shape MachiningLookupService.loadTable reads.
 *
 * A table added after 1137 was applied names its own migration (LATER below): 1137 never changes once applied, and the later table
 * ships in a file of its own, written by this same script from the same folder.
 *
 * MACHINING_WORKBOOK_MEMORY / MACHINING_WORKBOOK_OUT: another copy of memory/ to read and a folder to write to (to check that another
 * copy of the reference data, CI's, writes the committed files byte for byte).
 */
const { writeFileSync } = require('fs');
const { join } = require('path');
const { readCsv } = require('../migrations/scripts/lib/memory-machine-seed.js');

const MEMORY = process.env.MACHINING_WORKBOOK_MEMORY ?? join(__dirname, '../../memory');
const DIR = 'machining/workbook';
const MIGRATIONS = process.env.MACHINING_WORKBOOK_OUT ?? join(__dirname, '../migrations');
const OUT = join(MIGRATIONS, '1137_machining_workbook_cutting_data.sql');

// Each table, where in the workbook it comes from, and the columns every row must fill.
const TABLES = [
  { key: 'tblTurningConditions', from: 'Turning!A27:F59 "Turning cutting conditions"', required: ['WorkGroup', 'ToolMaterial', 'DepthMinMm', 'DepthMaxMm', 'FeedMinMmPerRev', 'FeedMaxMmPerRev', 'SpeedMinMPerMin', 'SpeedMaxMPerMin'] },
  { key: 'tblDrillReamData', from: 'Reaming!J1:U61 (drilling and reaming speed, feed per hole diameter band)', required: ['WorkMaterial', 'Operation', 'SpeedMinMPerMin', 'SpeedMaxMPerMin', 'DiameterMinMm', 'DiameterMaxMm', 'FeedMmPerRev'] },
  { key: 'tblHssHoleSpeeds', from: 'Tapping!A33:D58 (HSS drilling, reaming and tapping speed)', required: ['WorkGroup', 'Operation', 'SpeedMinMPerMin', 'SpeedMaxMPerMin'] },
  { key: 'tblBoringFeed', from: 'Boring!K26:L49 (boring feed per hole diameter band)', required: ['DiameterMinMm', 'FeedMinMmPerRev', 'FeedMaxMmPerRev'] },
  { key: 'tblMillingConditions', from: 'End Milling and Sawing!O8:Q61 (milling speed and feed per tooth)', required: ['WorkMaterial', 'SpeedMinMPerMin', 'SpeedMaxMPerMin', 'FeedPerToothMinMm', 'FeedPerToothMaxMm'] },
  { key: 'tblCorraxCutData', from: 'Uddeholm Corrax turning, drilling and end milling tables (pictures in the Facing, Step Drilling, Plunge and Slot Milling sheets)', required: ['Operation', 'ToolMaterial', 'SpeedMinMPerMin', 'SpeedMaxMPerMin', 'FeedMin', 'FeedMax', 'FeedUnit', 'Source'] },
  { key: 'tblCuttingToolCost', from: 'Tool cost and tool life of each sheet, priced from the supplier pictures beside them', required: ['Tool', 'PriceInr', 'ToolLifeParts', 'WorkbookSheets', 'PriceSource'] },
  { key: 'tblThermalCutFeed', from: 'Laser Cutting!H2:L32 / Plasma Cutting!H2:L32 (feed and kerf by machine and thickness)', required: ['Machine', 'ThicknessMm', 'FeedMmPerMin', 'KerfMm'] },
  { key: 'tblSawCutRate', from: 'Laser Cutting!I33:K33 (band saw, 2500 sq. mm/min)', required: ['Machine', 'AreaRateMm2PerMin'] },
  { key: 'tblCuttingMaterialGroup', from: "the engine's material classes mapped to each table's own material names", required: ['MaterialClass', 'DrillReamMaterial', 'MillingMaterial', 'CorraxData'] },
  {
    key: 'tblBallNoseCutData', migration: 1154,
    from: 'Haas Tooling ball nose end mill speeds and feeds, one row per published diameter with its URL',
    required: ['MillingMaterial', 'Teeth', 'ToolDiameterMm', 'DiameterMinMm', 'DiameterMaxMm', 'SpeedMPerMin', 'FeedPerToothMm', 'HaasRow', 'Source'],
  },
];

const tables = TABLES.map((t) => {
  const { rows } = readCsv(join(MEMORY, DIR, `${t.key}.csv`));
  if (rows.length === 0) throw new Error(`${t.key}: no rows`);
  rows.forEach((r, i) => {
    const missing = t.required.filter((c) => r[c] == null);
    if (missing.length) throw new Error(`${t.key} row ${i + 2}: ${missing.join(', ')} empty`);
  });
  return { ...t, rows };
});
const byKey = Object.fromEntries(tables.map((t) => [t.key, t.rows]));

// The material map names rows of the other tables: each name must be there, or the lookup would silently find nothing.
const names = (key, column) => new Set(byKey[key].map((r) => r[column]));
const checks = [
  ['TurningGroup', 'tblTurningConditions', 'WorkGroup'],
  ['DrillReamMaterial', 'tblDrillReamData', 'WorkMaterial'],
  ['HssGroup', 'tblHssHoleSpeeds', 'WorkGroup'],
  ['MillingMaterial', 'tblMillingConditions', 'WorkMaterial'],
];
for (const m of byKey.tblCuttingMaterialGroup) {
  for (const [column, key, target] of checks) {
    if (m[column] != null && !names(key, target).has(m[column])) throw new Error(`tblCuttingMaterialGroup ${m.MaterialClass}: ${column} "${m[column]}" is not a ${key} ${target}`);
  }
}
// The ball nose rows are found by the material's milling name (tblCuttingMaterialGroup MillingMaterial): each must be one of those names,
// with a source URL, and each material's diameter bands must run on from one another (each row from its own diameter to 0.001 mm under the
// next row's, so a ball the CAD states to 0.001 mm reads the row of its own published size; the first from 0, the last ending at its own).
const millingNames = names('tblCuttingMaterialGroup', 'MillingMaterial');
const ballNose = new Map();
for (const r of byKey.tblBallNoseCutData) {
  if (!millingNames.has(r.MillingMaterial)) throw new Error(`tblBallNoseCutData: "${r.MillingMaterial}" is no tblCuttingMaterialGroup MillingMaterial`);
  if (!/^https:[/][/]/.test(r.Source)) throw new Error(`tblBallNoseCutData ${r.MillingMaterial} ${r.ToolDiameterMm} mm: Source is not a URL`);
  ballNose.set(r.MillingMaterial, [...(ballNose.get(r.MillingMaterial) ?? []), r]);
}
for (const [material, rows] of ballNose) {
  rows.forEach((r, i) => {
    const min = i === 0 ? 0 : r.ToolDiameterMm;
    const max = i === rows.length - 1 ? r.ToolDiameterMm : Math.round((rows[i + 1].ToolDiameterMm - 0.001) * 1e6) / 1e6;
    if (r.DiameterMinMm !== min || r.DiameterMaxMm !== max) {
      throw new Error(`tblBallNoseCutData ${material} ${r.ToolDiameterMm} mm: band ${r.DiameterMinMm}-${r.DiameterMaxMm} does not run on from its neighbours`);
    }
  });
}

const insert = (t) => `INSERT INTO machining_reference_data (category, source_region, source_version, key, value, notes, raw)
VALUES ('lookup_table', 'USA', '2026-03', '${t.key}', '${t.rows.length}',
  $str$Machining workbook: ${t.from}$str$,
  $jsonb$${JSON.stringify(t.rows)}$jsonb$::jsonb)
ON CONFLICT (category, source_region, source_version, key) DO UPDATE SET value = EXCLUDED.value, notes = EXCLUDED.notes, raw = EXCLUDED.raw;`;

// 1137 holds the tables that have no later migration of their own.
const first = tables.filter((t) => t.migration == null);

const sql = `-- ============================================================================
-- Migration 1137: the machining workbook's cutting data
-- ============================================================================
-- Generated by scripts/generate-machining-workbook-reference-migration.js from memory/${DIR}/*.csv; re-run it and diff instead of editing.
--
-- The user's workbook memory/Machining - Calculator Database (1).xlsx times every cutting operation one way: spindle speed
-- n = 1000 v / (pi D), the cut length plus an approach allowance over the feed, times the passes, rounded up to whole seconds per use.
-- Its cutting speeds and feeds are tables on the sheets (scripts/extract-machining-workbook-tables.js wrote them to CSV) and pictures
-- pasted into the sheets (the Uddeholm Corrax tables, transcribed with their source; measured on that one tool steel, so the material
-- map points only tool steel at them). A range the workbook gives ("110-160") is kept as a Min and a Max; the calculator picks inside it.
--
${first.map((t) => `--   ${t.key.padEnd(24)} ${String(t.rows.length).padStart(3)} rows  ${t.from}`).join('\n')}
--
-- Staged under source_region USA like every other lookup table (MachiningLookupService reads them by key, for every location);
-- the data is the India workbook's. Tool prices are INR as the workbook gives them.
-- Idempotent: each table is re-set to the CSV.
-- ============================================================================

${first.map(insert).join('\n\n')}

DO $workbook_check$
DECLARE absent text[];
BEGIN
  SELECT array_agg(k ORDER BY k) INTO absent FROM unnest(ARRAY[${first.map((t) => `'${t.key}'`).join(', ')}]) AS k
   WHERE NOT EXISTS (SELECT 1 FROM machining_reference_data
                      WHERE category = 'lookup_table' AND source_version = '2026-03' AND key = k
                        -- other lookup tables stage an object (tblDrilling): the length is only taken of an array
                        AND CASE WHEN jsonb_typeof(raw) = 'array' THEN jsonb_array_length(raw) > 0 ELSE false END);
  IF absent IS NOT NULL THEN RAISE EXCEPTION 'Machining workbook tables not staged: %', absent; END IF;
END $workbook_check$;
`;

writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${first.length} tables, ${first.reduce((n, t) => n + t.rows.length, 0)} rows)`);

// The tables added after 1137, each in the migration it names.
const LATER = {
  1154: {
    file: '1154_machining_ball_nose_cut_data.sql',
    title: "the ball nose end mill's cutting data",
    why: [
      "A concave fillet or a groove is finished by a ball nose end mill of its own radius along its path (the operation sequencer's",
      'Concave Fillet Milling and Groove Milling; project owner decision of 2026-11-25). The workbook has no ball nose data: its milling',
      "conditions are a flat end mill's. These are Haas Tooling's published ball nose speeds and feeds, one row per published diameter: the",
      'inch tables converted (SFM x 0.3048 = m/min, inch per tooth x 25.4 = mm per tooth, the fraction x 25.4 = mm), each row naming the table,',
      'material row and diameter it is from (HaasRow) and its URL (Source). The material is the workbook milling name (tblCuttingMaterialGroup',
      "MillingMaterial). A row's band runs from its own diameter to 0.001 mm under the next row's (the CAD states a radius to 0.001 mm, so a",
      'ball of a published size reads its own row); the first from 0, so a ball smaller than the smallest published is read at that row and',
      "fed at its feed per tooth scaled by the two diameters (the calculators' Feed per Tooth says so). Above the largest published diameter",
      'there is no row: a named gap.',
      '',
      'The tables are for 3D profiling (light steps: ae and ap as each row states), so a fillet or a groove cut full radius in one pass at',
      "these feeds is timed at the published profiling rate, not a slotting rate; the calculators' descriptions say so.",
    ],
  },
};
for (const [n, { file, title, why }] of Object.entries(LATER)) {
  const own = tables.filter((t) => t.migration === Number(n));
  if (own.length === 0) throw new Error(`no workbook table is marked for migration ${n}`);
  const later = `-- ============================================================================
-- Migration ${n}: ${title}
-- ============================================================================
-- Generated by scripts/generate-machining-workbook-reference-migration.js from memory/${DIR}/*.csv; re-run it and diff instead of editing.
--
${why.map((l) => (l ? `-- ${l}` : '--')).join('\n')}
--
${own.map((t) => `--   ${t.key.padEnd(24)} ${String(t.rows.length).padStart(3)} rows  ${t.from}`).join('\n')}
--
-- Staged under source_region USA like every other lookup table (MachiningLookupService reads them by key, for every location).
-- Idempotent: each table is re-set to the CSV.
-- ============================================================================

${own.map(insert).join('\n\n')}

DO $workbook_check$
DECLARE absent text[];
BEGIN
  SELECT array_agg(k ORDER BY k) INTO absent FROM unnest(ARRAY[${own.map((t) => `'${t.key}'`).join(', ')}]) AS k
   WHERE NOT EXISTS (SELECT 1 FROM machining_reference_data
                      WHERE category = 'lookup_table' AND source_version = '2026-03' AND key = k
                        -- other lookup tables stage an object (tblDrilling): the length is only taken of an array
                        AND CASE WHEN jsonb_typeof(raw) = 'array' THEN jsonb_array_length(raw) > 0 ELSE false END);
  IF absent IS NOT NULL THEN RAISE EXCEPTION 'Machining workbook tables not staged: %', absent; END IF;
END $workbook_check$;
`;
  writeFileSync(join(MIGRATIONS, file), later);
  console.log(`wrote ${file} (${own.length} tables, ${own.reduce((k, t) => k + t.rows.length, 0)} rows)`);
}
