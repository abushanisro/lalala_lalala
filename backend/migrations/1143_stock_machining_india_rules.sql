-- ============================================================================
-- Migration 1143: India's stock rules, from the machining calculator workbook
-- ============================================================================
-- The stock a machined part is cut from is chosen and priced on memory/Stock Maching's rules (source version 2026-Stock-Machining,
-- migrations 816 and 1114), staged for the USA. India's quotes read them too: a 6096 mm (20 ft) bar, a 914.4 x 457.2 mm plate, a 0.889 mm
-- band saw kerf, the scrap never credited. The machining calculator workbook (memory/Machining - Calculator Database (1).xlsx) states
-- India's own, on its four Material calc sheets (Rod, Tube, Sheets, Blocks; material city India, prices in INR):
--
--   standardStockLength        3000   Rod / Tube C9 "Length of RM Rod/Pipe" 3000 mm
--   stockBarEndRemnant         5      Rod / Tube G8 "Minimum Leftover" 5 mm: parts = (3000 - 5) / (part length + 2)
--   bandSawKerf                2      Rod / Tube G7 "Cut off allowance" 2 mm: the stock lost between two parts
--   standardPlateLength        3000   Sheets C6 "length of sheet" 3000 mm
--   standardPlateWidth         1000   Sheets C7 "Width of sheet" 1000 mm
--   enableScrapMaterialCredit  true   every sheet takes the scrap off the material cost (K9 / K7 "Material Cost" = RM cost - scrap cost)
--   scrapRecoveryPercent       95     Rod / Tube G13, Sheets / Blocks G12 "Scrap Recovery" 95 %: only that share of the scrap is sold
--
-- Staged beside the USA rows under source_region India (the project owner's decision of 2026-11-24: India material rules and scrap
-- recovery). The reader takes a location's own row where it has one, else the reference's (sand-reference.service.ts rowsForRegion), so
-- every other rule (the stock allowance, snapping, the preferred sizes) is the reference's for India too. stockBarEndRemnant and
-- scrapRecoveryPercent are new keys: the reference states neither (its bar end is the engine's researched 152.4 mm, stock-research.ts).
-- The scrap is priced as before, at the material's Scrap Cost Percent of its stock price: no table holds a scrap price per kg.
--
-- Idempotent: the rows are upserted on (category, source_region, source_version, key).
-- ============================================================================

INSERT INTO machining_reference_data (category, source_region, source_version, key, value, unit_type, notes, raw) VALUES
  ('variable', 'India', $str$2026-Stock-Machining$str$, $str$standardStockLength$str$, $str$3000$str$, $str$Length$str$, $str$Machining calculator workbook, Material Calc - Rod / Tube C9: Length of RM Rod/Pipe 3000 mm (India)$str$,
    $jsonb${"Variable Name":"standardStockLength","String Value":3000,"Unit Type Name":"Length","Notes":"Machining calculator workbook, Material Calc - Rod / Tube C9: Length of RM Rod/Pipe 3000 mm (India)"}$jsonb$),
  ('variable', 'India', $str$2026-Stock-Machining$str$, $str$stockBarEndRemnant$str$, $str$5$str$, $str$Length$str$, $str$Machining calculator workbook, Material Calc - Rod / Tube G8: Minimum Leftover 5 mm (India)$str$,
    $jsonb${"Variable Name":"stockBarEndRemnant","String Value":5,"Unit Type Name":"Length","Notes":"Machining calculator workbook, Material Calc - Rod / Tube G8: Minimum Leftover 5 mm (India)"}$jsonb$),
  ('variable', 'India', $str$2026-Stock-Machining$str$, $str$bandSawKerf$str$, $str$2$str$, $str$Length$str$, $str$Machining calculator workbook, Material Calc - Rod / Tube G7: Cut off allowance 2 mm (India)$str$,
    $jsonb${"Variable Name":"bandSawKerf","String Value":2,"Unit Type Name":"Length","Notes":"Machining calculator workbook, Material Calc - Rod / Tube G7: Cut off allowance 2 mm (India)"}$jsonb$),
  ('variable', 'India', $str$2026-Stock-Machining$str$, $str$standardPlateLength$str$, $str$3000$str$, $str$Length$str$, $str$Machining calculator workbook, Material calc - Sheets C6: length of sheet 3000 mm (India)$str$,
    $jsonb${"Variable Name":"standardPlateLength","String Value":3000,"Unit Type Name":"Length","Notes":"Machining calculator workbook, Material calc - Sheets C6: length of sheet 3000 mm (India)"}$jsonb$),
  ('variable', 'India', $str$2026-Stock-Machining$str$, $str$standardPlateWidth$str$, $str$1000$str$, $str$Length$str$, $str$Machining calculator workbook, Material calc - Sheets C7: Width of sheet 1000 mm (India)$str$,
    $jsonb${"Variable Name":"standardPlateWidth","String Value":1000,"Unit Type Name":"Length","Notes":"Machining calculator workbook, Material calc - Sheets C7: Width of sheet 1000 mm (India)"}$jsonb$),
  ('variable', 'India', $str$2026-Stock-Machining$str$, $str$enableScrapMaterialCredit$str$, $str$true$str$, NULL, $str$Machining calculator workbook, every Material calc sheet: Material Cost = RM cost - scrap cost (India)$str$,
    $jsonb${"Variable Name":"enableScrapMaterialCredit","String Value":"true","Unit Type Name":null,"Notes":"Machining calculator workbook, every Material calc sheet: Material Cost = RM cost - scrap cost (India)"}$jsonb$),
  ('variable', 'India', $str$2026-Stock-Machining$str$, $str$scrapRecoveryPercent$str$, $str$95$str$, $str$Percent$str$, $str$Machining calculator workbook, Material Calc - Rod / Tube G13, Material calc - Sheets / Blocks G12: Scrap Recovery 95 % (India)$str$,
    $jsonb${"Variable Name":"scrapRecoveryPercent","String Value":95,"Unit Type Name":"Percent","Notes":"Machining calculator workbook, Material Calc - Rod / Tube G13, Material calc - Sheets / Blocks G12: Scrap Recovery 95 % (India)"}$jsonb$)
ON CONFLICT (category, source_region, source_version, key) DO UPDATE
  SET value = EXCLUDED.value, unit_type = EXCLUDED.unit_type, notes = EXCLUDED.notes, raw = EXCLUDED.raw;

DO $india_check$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM machining_reference_data
   WHERE category = 'variable' AND source_region = 'India' AND source_version = '2026-Stock-Machining'
     AND key IN ('standardStockLength', 'stockBarEndRemnant', 'bandSawKerf', 'standardPlateLength', 'standardPlateWidth', 'enableScrapMaterialCredit', 'scrapRecoveryPercent');
  IF n <> 7 THEN RAISE EXCEPTION 'India stock rules: % of 7 rows staged', n; END IF;
END $india_check$;
