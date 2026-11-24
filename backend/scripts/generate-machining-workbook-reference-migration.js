/**
 * Writes migration 1137 (the machining workbook's cutting data) from memory/machining/workbook/*.csv:
 *   node scripts/generate-machining-workbook-reference-migration.js
 *
 * The user's workbook memory/Machining - Calculator Database (1).xlsx times every cutting operation the same way: spindle speed from a
 * cutting speed, passes, the cut length plus an approach allowance over the feed, rounded up to whole seconds per use. Its cutting
 * speeds and feeds are tables on the sheets (extracted by scripts/extract-machining-workbook-tables.js) and pictures pasted into them
 * (the Uddeholm Corrax tables, written by hand with their source). Each CSV is staged whole as one lookup_table row of
 * machining_reference_data, the shape MachiningLookupService.loadTable reads.
 */
const { writeFileSync } = require('fs');
const { join } = require('path');
const { readCsv } = require('../migrations/scripts/lib/memory-machine-seed.js');

const MEMORY = join(__dirname, '../../memory');
const DIR = 'machining/workbook';
const OUT = join(__dirname, '../migrations/1137_machining_workbook_cutting_data.sql');

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

const insert = (t) => `INSERT INTO machining_reference_data (category, source_region, source_version, key, value, notes, raw)
VALUES ('lookup_table', 'USA', '2026-03', '${t.key}', '${t.rows.length}',
  $str$Machining workbook: ${t.from}$str$,
  $jsonb$${JSON.stringify(t.rows)}$jsonb$::jsonb)
ON CONFLICT (category, source_region, source_version, key) DO UPDATE SET value = EXCLUDED.value, notes = EXCLUDED.notes, raw = EXCLUDED.raw;`;

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
${tables.map((t) => `--   ${t.key.padEnd(24)} ${String(t.rows.length).padStart(3)} rows  ${t.from}`).join('\n')}
--
-- Staged under source_region USA like every other lookup table (MachiningLookupService reads them by key, for every location);
-- the data is the India workbook's. Tool prices are INR as the workbook gives them.
-- Idempotent: each table is re-set to the CSV.
-- ============================================================================

${tables.map(insert).join('\n\n')}

DO $workbook_check$
DECLARE absent text[];
BEGIN
  SELECT array_agg(k ORDER BY k) INTO absent FROM unnest(ARRAY[${tables.map((t) => `'${t.key}'`).join(', ')}]) AS k
   WHERE NOT EXISTS (SELECT 1 FROM machining_reference_data
                      WHERE category = 'lookup_table' AND source_version = '2026-03' AND key = k
                        -- other lookup tables stage an object (tblDrilling): the length is only taken of an array
                        AND CASE WHEN jsonb_typeof(raw) = 'array' THEN jsonb_array_length(raw) > 0 ELSE false END);
  IF absent IS NOT NULL THEN RAISE EXCEPTION 'Machining workbook tables not staged: %', absent; END IF;
END $workbook_check$;
`;

writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${tables.length} tables, ${tables.reduce((n, t) => n + t.rows.length, 0)} rows)`);
