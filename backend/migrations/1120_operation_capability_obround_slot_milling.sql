-- ============================================================================
-- Migration 1120: a milled keyway's operation gets its tolerance capability
-- ============================================================================
-- operation_capability_process (staged by migration 882 from memory/Machining/lookup) names, for a machining operation, the row of
-- tblGtolProcessCapabilities its tolerances are judged against. It links "Rough Milling" to "Milling" and has no row for any
-- slot-milling operation.
--
-- A keyway that is not broached is milled as "Obround Slot Milling" (the calculator of migration 1118), and the feature now carries
-- that operation as its label (canonical-operation.ts) instead of "Rough Milling". Without a link for it a keyway's required
-- tolerances would not be judged at all ("no operation with a capability on file").
--
-- This adds the one row, the project owner's decision of 2026-11-23:
--   Operation "Obround Slot Milling", Capability Process "Milling", Basis "process family (user decision 2026-11-23)"
-- Milling is the capability a keyway was judged against under "Rough Milling", so a machined keyway's verdict does not move. On a cast,
-- forged or pressed part the operation joins Rough Milling as a milling operation that can finish a keyway; the machining priced
-- after those processes has no machine for either, so no cost moves.
--
-- The staged row stays consistent: the new row is appended to raw.rows, value (the row count) goes from 35 to 36, and notes says
-- where the row came from. raw.status, raw.columns and raw.source_files are unchanged.
--
-- Idempotent: the row is added only while the table has no "Obround Slot Milling" row. A database where migration 882 staged no
-- table is left as it is, with a notice. Listed in REFERENCE_DATA.json's exceptions.
-- ============================================================================

UPDATE machining_reference_data m
SET raw = jsonb_set(m.raw, '{rows}', (m.raw->'rows') || '[{"Operation":"Obround Slot Milling","Capability Process":"Milling","Basis":"process family (user decision 2026-11-23)"}]'::jsonb),
    value = (jsonb_array_length(m.raw->'rows') + 1)::text,
    notes = concat_ws('; ', m.notes, 'Obround Slot Milling -> Milling added by migration 1120 (user decision 2026-11-23)')
WHERE m.category = 'lookup_table' AND m.source_version = '2026-03' AND m.key = 'operation_capability_process'
  AND jsonb_typeof(m.raw->'rows') = 'array'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.raw->'rows') r WHERE r->>'Operation' = 'Obround Slot Milling');

-- The check: where the table is staged, it links Obround Slot Milling to Milling, once.
DO $check$
DECLARE
  staged int;
  linked int;
BEGIN
  SELECT count(*) INTO staged FROM machining_reference_data
  WHERE category = 'lookup_table' AND source_version = '2026-03' AND key = 'operation_capability_process';
  IF staged = 0 THEN
    RAISE NOTICE 'Migration 1120: operation_capability_process is not staged in this database (migration 882); nothing to add';
    RETURN;
  END IF;

  SELECT count(*) INTO linked FROM machining_reference_data m
  WHERE m.category = 'lookup_table' AND m.source_version = '2026-03' AND m.key = 'operation_capability_process'
    AND jsonb_typeof(m.raw->'rows') = 'array'
    AND (SELECT count(*) FILTER (WHERE r->>'Capability Process' = 'Milling') = 1 AND count(*) = 1
         FROM jsonb_array_elements(m.raw->'rows') r WHERE r->>'Operation' = 'Obround Slot Milling');
  IF linked <> staged THEN
    RAISE EXCEPTION 'Migration 1120 failed: operation_capability_process does not link Obround Slot Milling to Milling exactly once';
  END IF;
  RAISE NOTICE 'Migration 1120 OK: operation_capability_process links Obround Slot Milling to Milling';
END
$check$;
