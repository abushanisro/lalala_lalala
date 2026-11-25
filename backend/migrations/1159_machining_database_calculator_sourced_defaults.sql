-- ============================================================================
-- Migration 1159: sourced defaults of the machining calculators that live only in the database
-- ============================================================================
-- Four machining calculators are rows the project owner made in the calculator builder (2026-05-15), not entries of the machining
-- calculator spec (machining-calculators.json, migrations 804-1158): "Machining - Tapping" (fe42139c, the Tapping line every part carries
-- runs it through the tapping physics, migrations 052-056), "Machining - Block Material Cost" (8a5e5b62), "Machining - Sheet Material
-- Cost" (81d35b8e) and "Machining - Material Information" (bd8c28c1). Their defaults had no stated source, and the eye beside a default
-- (evaluateCalculatorFields, calculatorField) said "not yet sourced". The research of 2026-11-25 (user decisions of that day) sources each
-- from the Machining calculator workbook (memory/Machining - Calculator Database (1).xlsx; every cell below read from it) or a published
-- source; this writes the value it gives and the source, which the eye shows, into input_config.source:
--
--   Machining - Tapping
--     Tool Cost        0 -> Rs 100 (Threading!C10 "Tool cost" INR 100, the cost block of the sheet that pictures the tap), in US dollars
--                      at the active USD/INR rate on file (exchange_rates), since the calculator prices in $ (migration 055); left as it
--                      is, with a notice, where no active rate is on file.
--     Tool Life        0 -> 300 parts (Threading!C11 "Tool life" Parts 300).
--     Tool Change Time 3 -> 4.2 s (Haas VF-2 "Tool-to-Tool (avg) 4.2 sec"); Unload Time 2 -> 1 s and Approach Time 1 s (closest published
--                      basis: a machining centre's spindle start/stop, Numeryx "at 2000 rpm the accel time is 1 sec"). These are the
--                      formula captions of the physics the calculator runs (TAP_* in default-rates.constants.ts, changed with this).
--     OLE 80 %, Setup Percentage 30 %, Tool Code 0, No of Uses 1: sources only (Facing!C14, C13, C9 and Knurling!K4).
--   Machining - Block Material Cost and Machining - Sheet Material Cost
--     Allowance        2 -> 6 mm (Material calc - Blocks!G16 / Material calc - Sheets!G16 "Allowance both sides" 6), relabelled "both
--                      sides": the formula adds it once to each dimension, as the sheet's G8 does, so "per side" was wrong.
--     Material Category Steel -> Aluminium and Density 7.85 -> 2.7 g/cc: the sheets' worked example (C4 "Aluminium", C5 2700 kg/m3).
--                      An example, not a rule: the part's own material fills them. The density moves with the category so the two agree.
--     Sheet Length / Width 2500 x 1250 -> 3000 x 1000 mm (Material calc - Sheets!C6, C7); Scrap Recovery 95 %: source only (G12).
--   Machining - Material Information
--     Material Category Stainless Steel, Material Grade SS303: sources only (RM Composition Analysis!G4, G5, the worked example).
--
-- Fixed ids, as migrations 052-055: a database without these calculators is left as it is. Idempotent.
-- ============================================================================

BEGIN;

DO $m$
DECLARE
  tapping CONSTANT uuid := 'fe42139c-5675-4a82-94d5-7f2d440ae9bf';
  block CONSTANT uuid := '8a5e5b62-4f20-46fd-9fc9-ca25f14a9714';
  sheet CONSTANT uuid := '81d35b8e-3345-4282-a30d-170491e2615e';
  info CONSTANT uuid := 'bd8c28c1-af43-41a3-a5fb-fe214eb2c48d';
  wb CONSTANT text := 'the Machining calculator workbook (memory/Machining - Calculator Database (1).xlsx)';
  inr_per_usd numeric;
  rate_day date;
BEGIN
  -- A database without any of the four (a new one, or the local stack's stubs) has nothing to source.
  IF NOT EXISTS (SELECT 1 FROM public.calculators WHERE id IN (tapping, block, sheet, info)) THEN
    RETURN;
  END IF;

  -- A default and where it comes from; the value is left as it is when `val` is null.
  CREATE TEMP TABLE m1159_defaults (calculator_id uuid, field_name text, val text, label text, source text) ON COMMIT DROP;

  INSERT INTO m1159_defaults VALUES
    (tapping, 'Tool Life', '300', NULL, wb || ', Threading sheet C11: Tool life 300 parts (the cost block of the sheet that pictures the tap; the Tapping sheet has none).'),
    (tapping, 'Tool Change Time', '4.2', NULL, 'A vertical machining centre''s average tool-to-tool time: Haas VF-2 specification (haas.co.uk/machines/vf-2), "Tool-to-Tool (avg) 4.2 sec". The tapping physics (TAP_TOOL_CHANGE_SEC) uses the same value.'),
    (tapping, 'Approach Time', '1', NULL, 'Closest published basis: the spindle start of a general-purpose machining centre, Numeryx An-101 (numeryx.com/cnc/drilling51.htm): "at 2000 rpm the accel time is 1 sec" (a tapping centre: 0.15 s, Brother SPEEDIO S1000X1). The tapping physics (TAP_APPROACH_SEC) uses the same value.'),
    (tapping, 'Unload Time', '1', NULL, 'Closest published basis: the spindle stop of a general-purpose machining centre, Numeryx An-101 (numeryx.com/cnc/drilling51.htm): "at 2000 rpm the accel time is 1 sec" (a tapping centre: 0.15 s, Brother SPEEDIO S1000X1). It was 2 s, unsourced. The tapping physics (TAP_UNLOAD_SEC) uses the same value.'),
    (tapping, 'OLE', NULL, NULL, wb || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (tapping, 'Setup Percentage', NULL, NULL, wb || ', Facing sheet C13: Setup Percentage 30 % (the Knurling and Threading sheets use 15 %).'),
    (tapping, 'Tool Code', NULL, NULL, wb || ', every sheet''s cost block (Facing sheet C9): Tool code 0.'),
    (tapping, 'No of Uses', NULL, NULL, wb || ', Knurling sheet K4: No of uses 1. A count of the threads; the engine fills it from the thread callout.'),
    (block, 'Allowance', '6', 'Machining Allowance, both sides (mm)', wb || ', Material calc - Blocks sheet G16: Allowance both sides 6 mm (added once to each dimension, as G8 =(G4+G16)*(G16+G5)*G6).'),
    (block, 'Material Category', 'Aluminium', NULL, wb || ', Material calc - Blocks sheet C4: Material code Aluminium, the sheet''s worked example. An example, not a rule: the part''s own material fills it.'),
    (block, 'Density', '2.7', NULL, wb || ', Material calc - Blocks sheet C5: Density 2700 kg/m3 (2.7 g/cc), the worked example''s aluminium; the raw material record fills it.'),
    (block, 'Scrap Recovery', NULL, NULL, wb || ', Material calc - Blocks sheet G12: Scrap recovery 95 %.'),
    (sheet, 'Allowance', '6', 'Machining Allowance, both sides (mm)', wb || ', Material calc - Sheets sheet G16: Allowance both sides 6 mm (added once to each dimension, as G8 =(G4+G16)*(G16+G5)*G6).'),
    (sheet, 'Material Category', 'Aluminium', NULL, wb || ', Material calc - Sheets sheet C4: Material code Aluminium, the sheet''s worked example. An example, not a rule: the part''s own material fills it.'),
    (sheet, 'Density', '2.7', NULL, wb || ', Material calc - Sheets sheet C5: Density 2700 kg/m3 (2.7 g/cc), the worked example''s aluminium; the raw material record fills it.'),
    (sheet, 'Scrap Recovery', NULL, NULL, wb || ', Material calc - Sheets sheet G12: Scrap recovery 95 %.'),
    (sheet, 'Sheet Length', '3000', NULL, wb || ', Material calc - Sheets sheet C6: length of sheet 3000 mm (2500 x 1250 is the sheet metal workbook''s sheet, not the machining one).'),
    (sheet, 'Sheet Width', '1000', NULL, wb || ', Material calc - Sheets sheet C7: Width of sheet 1000 mm.'),
    (info, 'Material Category', NULL, NULL, wb || ', RM Composition Analysis sheet G4: Material category Stainless steel, the worked example. The part''s own material fills it.'),
    (info, 'Material Grade', NULL, NULL, wb || ', RM Composition Analysis sheet G5: Material grade SS303, the worked example. The part''s own material fills it.');

  -- Tool Cost: Rs 100 in the calculator's US dollars, at the active rate on file.
  SELECT rate, effective_date INTO inr_per_usd, rate_day FROM public.exchange_rates
  WHERE from_currency = 'USD' AND to_currency = 'INR' AND is_active ORDER BY effective_date DESC LIMIT 1;
  IF inr_per_usd IS NULL THEN
    INSERT INTO m1159_defaults VALUES (tapping, 'Tool Cost', NULL, NULL,
      wb || ', Threading sheet C10: Tool cost INR 100. Not converted to US dollars: no active USD/INR rate was on file when migration 1159 ran.');
    RAISE NOTICE 'migration 1159: no active USD/INR exchange rate; Machining - Tapping Tool Cost left as it is';
  ELSE
    INSERT INTO m1159_defaults VALUES (tapping, 'Tool Cost', to_char(round(100 / inr_per_usd, 2), 'FM999990.00'), NULL,
      wb || ', Threading sheet C10: Tool cost INR 100 (the cost block of the sheet that pictures the tap), in US dollars at the active USD/INR rate on file, '
        || inr_per_usd::text || ' of ' || rate_day::text || ' (exchange_rates).');
  END IF;

  UPDATE public.calculator_fields f
  SET default_value = COALESCE(d.val, f.default_value),
      display_label = COALESCE(d.label, f.display_label),
      input_config = COALESCE(f.input_config, '{}'::jsonb) || jsonb_build_object('source', d.source),
      updated_at = now()
  FROM m1159_defaults d
  WHERE f.calculator_id = d.calculator_id AND f.field_name = d.field_name;
END
$m$;

-- Post-check: every field of these calculators that is present has its source.
DO $post$
DECLARE bad TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.calculators WHERE id IN ('fe42139c-5675-4a82-94d5-7f2d440ae9bf', '8a5e5b62-4f20-46fd-9fc9-ca25f14a9714',
                                                            '81d35b8e-3345-4282-a30d-170491e2615e', 'bd8c28c1-af43-41a3-a5fb-fe214eb2c48d')) THEN
    RETURN;
  END IF;
  SELECT string_agg(c.name || ': ' || f.field_name, ', ') INTO bad
  FROM public.calculator_fields f JOIN public.calculators c ON c.id = f.calculator_id
  WHERE (c.id, f.field_name) IN (
    ('fe42139c-5675-4a82-94d5-7f2d440ae9bf'::uuid, 'Tool Cost'), ('fe42139c-5675-4a82-94d5-7f2d440ae9bf'::uuid, 'Tool Life'),
    ('8a5e5b62-4f20-46fd-9fc9-ca25f14a9714'::uuid, 'Allowance'), ('81d35b8e-3345-4282-a30d-170491e2615e'::uuid, 'Allowance'),
    ('81d35b8e-3345-4282-a30d-170491e2615e'::uuid, 'Sheet Length'), ('81d35b8e-3345-4282-a30d-170491e2615e'::uuid, 'Sheet Width'))
    AND NOT (f.input_config ? 'source');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 1159: defaults without a source: %', bad;
  END IF;
END
$post$;

COMMIT;
