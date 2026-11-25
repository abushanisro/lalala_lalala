-- ============================================================================
-- Migration 1162: sourced defaults of the sheet metal, post processing and plastic calculators that live only in the database
-- ============================================================================
-- These calculators are rows the project owner made in the calculator builder (migrations/calculators/007-058, 2026-05-15 to 2026-08-07;
-- migration 399; "Laser Cut Time Calculator", 2026-06-15), not entries of a family's calculator spec. Their defaults had no stated source, and
-- the eye beside a default (calculatorField, fieldSourceNote) said "not yet sourced". The research of 2026-11-25 (user decisions of that day)
-- sources each from the Sheet Metal calculator workbook (memory/database/Sheet Metal Calculators (2-9-23) (1) (1).xlsx; every cell below
-- read again from the file), the Machining calculator workbook, memory/ or a published source; this writes the value it gives and the
-- source, which the eye shows, into input_config.source. A value with no source anywhere is kept, and its source says so; a placeholder the
-- part fills says that it is one.
--
-- Values that change:
--   Sheet Metal - TPP Cost Drivers        Direct Labors 1 -> 0.5 (TPP!D61: a turret punch is half an operator; 1 doubled its labour)
--   Sheet Metal Waterjet Cutting - Material Information
--                                         Part Allowance (the kerf) 0.9 -> 0.76 mm (OMAX: the kerf is the mixing tube's width, 0.030 in)
--   Laser Cut Time Calculator             Cut Speed 4000 -> 4200 mm/min (Cutting (Laser)!D52 4.2 m/min; Machining workbook Laser Cutting!K25)
--                                         Pierce Time 1.5 -> 1.2 s (Cutting (Laser)!D54 =0.02*D51 min, 0.02 min a pierce)
--   Tonnage Calculator                    Saftey factor 1.2 -> 1.1 (memory/Plastic Modeling clampForceSafetyFactor, the injection engine's)
--   Sheet Metal - Counterboring and Sheet Metal - Countersinking (version + 1)
--                                         Tool Cost 0 -> USD 6.00 and Tool Life 0 parts -> 15 min of cutting (memory/Machining tblCounterboring and,
--                                         for the countersink, tblChamfering: tool_life_cost_usd 6.0 per tool_life_min 15). The life is now in
--                                         minutes, so Tool Cost per Part = Tool Cost x No of Uses x Machining Time Min / Tool Life (it was
--                                         Tool Cost / Tool Life with the life in parts).
--   Sheet Metal - Stamping Cost Drivers (version + 1)
--                                         No Of Impressions 1 -> computed as the workbook computes it, Stamping & Bending!D35
--                                         =ROUNDDOWN((D36-D38)/(D28+D34),0): (Coil Width - Start & End Scrap) / (Unfolded Length + Part Allowance),
--                                         the part allowance D34 =0.01 x thickness x sqrt(shear strength / 10) + 10. New inputs: Coil Width 500 mm
--                                         (D36), Start End Scrap 20 mm (D38), and the part's Unfolded Length, Thickness and Shear Strength (D28, D30,
--                                         D51, from the part). The sheet's example gives 7 impressions.
--   Post Processing - Ultrasonic Cleaning and Post Processing - Surface Treatment (both copies of each; version + 1)
--                                         Lot Size 1 -> annual volume / 12, as the workbook computes it (Stamping & Bending!D16 =+D8/12; TPP!F16
--                                         "Populated from template upload or default to annual volume/12"). A new Annual Volume input takes the
--                                         part's annual volume. A lot of 1 charged a whole batch's time to every part.
--   Shot Weight Calculator (version + 1)  Runner Dia 7 mm -> computed. Closest published basis: D = sqrt(W) x L^0.25 / 3.7 (W the part weight in
--                                         g, L the runner length in mm; Pye, Injection Mould Design), at least 1.5 x the wall (Beaumont, "a minimum
--                                         runner diameter is estimated as being 1.5x the wall thickness of the plastic part"). A new Wall Thickness
--                                         input takes the part's nominal wall. No published source states a fixed 7 mm.
--
-- None of these calculators is run by a cost engine except Counterboring and Countersinking (the drill press's hole operations), whose lines
-- take only their times from them: the tool cost they now state is in the calculator's Total Process Cost, not yet on the line.
--
-- Fixed ids, as migrations 052-055 and 1159: a database without these calculators is left as it is, and a change to a calculator's fields is
-- made only where the calculator still has the fields it replaces. Idempotent.
-- ============================================================================

BEGIN;

DO $m$
DECLARE
  bend_cd CONSTANT uuid := '4e738d77-b818-4c2a-8d44-2e71cbde4d7b';
  bend_mfg CONSTANT uuid := '102772ff-5422-45c1-b391-6d2d4a96ab1b';
  cbore CONSTANT uuid := 'edccd27a-c91c-479d-a440-d00053249a3a';
  csink CONSTANT uuid := '0f7d6451-3937-472d-9a4c-3f8f3ebf59d8';
  deburr CONSTANT uuid := 'cc4291f1-15fc-4038-88bc-c74c3480f168';
  df_cd CONSTANT uuid := '74abe76f-5f27-4600-9369-07576d481f73';
  df_mfg CONSTANT uuid := '966fff11-5b69-44bc-ad55-6645f1df223c';
  gross CONSTANT uuid := '432d6322-dca7-4664-90a4-332d594ed684';
  burr CONSTANT uuid := 'ecf632c6-5ff3-40a5-b392-0b8c646c79c2';
  insp CONSTANT uuid := 'e7eae3f2-b221-475d-b82b-8b5fb0592a6d';
  laser_cd CONSTANT uuid := '5f7a6110-5f2f-400d-be79-982894aa7f89';
  laser_mfg CONSTANT uuid := 'f8537846-b0eb-4d49-9cfb-a93f6b9e2c63';
  pem1 CONSTANT uuid := '97d947bd-fb5a-477b-af35-d3eb2c938983';
  pem2 CONSTANT uuid := '72f84130-a741-425f-8fa9-9b027541801c';
  roll CONSTANT uuid := '9cbf2166-07be-4070-8e00-0b6c5075f71e';
  stamp_cd CONSTANT uuid := '450d3468-70b2-41cc-924e-ffe1b17952f7';
  stamp_mfg CONSTANT uuid := 'e12094c7-cdfd-4dde-a153-1f98a5250a72';
  tpp_cd CONSTANT uuid := '0c841b0a-2eaf-4482-9654-9ff366f07fa2';
  tpp_info CONSTANT uuid := 'b4beb74f-bf03-4637-8c83-01acb8c18177';
  df_info CONSTANT uuid := '3dc73e27-8397-4715-980a-a7b1cf9eb0e0';
  laser_info CONSTANT uuid := 'd82a0a57-ced8-4428-9f97-c11604ce8e39';
  wj_info CONSTANT uuid := '3c9ad24c-952a-48d4-beda-66507961ee0d';
  laser_time CONSTANT uuid := '6c32140d-ffc1-44b3-a744-a354da813928';
  surf1 CONSTANT uuid := '0bbea0e0-8f1b-445c-b23d-a194cf8270e9';
  surf2 CONSTANT uuid := 'a3935f86-ea9f-4272-96d1-6cc14261513a';
  ultra1 CONSTANT uuid := '664cb15f-66dd-460d-86c6-7684075147ea';
  ultra2 CONSTANT uuid := '34f8dff4-d20f-4707-97a8-27fceca29b04';
  shot CONSTANT uuid := '3020005f-2dea-40f0-93ad-540c2670cebd';
  tonnage CONSTANT uuid := '08664969-fa5e-4f5b-a1bd-e847de9dc3dd';
  sm CONSTANT text := 'The Sheet Metal calculator workbook (memory/database/Sheet Metal Calculators (2-9-23) (1) (1).xlsx)';
  mw CONSTANT text := 'The Machining calculator workbook (memory/Machining - Calculator Database (1).xlsx)';
  lot_source CONSTANT text := 'The Sheet Metal calculator workbook (memory/database/Sheet Metal Calculators (2-9-23) (1) (1).xlsx), Stamping & Bending sheet D16: Lot size =+D8/12, the annual volume over 12 (TPP sheet F16: "Populated from template upload or default to annual volume/12"). Was a fixed 1, which charged a whole batch''s time to every part.';
  v uuid;
  o integer;
BEGIN
  -- A database without any of these calculators (a new one, or the local stack's stubs) has nothing to source.
  IF NOT EXISTS (SELECT 1 FROM public.calculators WHERE id IN (bend_cd, bend_mfg, cbore, csink, deburr, df_cd, df_mfg, gross, burr, insp, laser_cd,
      laser_mfg, pem1, pem2, roll, stamp_cd, stamp_mfg, tpp_cd, tpp_info, df_info, laser_info, wj_info, laser_time, surf1, surf2, ultra1, ultra2,
      shot, tonnage)) THEN
    RETURN;
  END IF;

  -- Counterboring and countersinking: the tool's wear by the minutes it cuts (the life was in parts, and both were 0).
  FOREACH v IN ARRAY ARRAY[cbore, csink] LOOP
    IF EXISTS (SELECT 1 FROM public.calculator_fields WHERE calculator_id = v AND field_name = 'Tool Cost per Part'
               AND default_value = 'IF({Tool Life} > 0, {Tool Cost} / {Tool Life}, 0)') THEN
      UPDATE public.calculator_fields
      SET default_value = 'IF({Tool Life} > 0, {Tool Cost} * {No of Uses} * {Machining Time Min} / {Tool Life}, 0)',
          display_label = 'Tool Cost/Part ($)', unit = '$',
          input_config = COALESCE(input_config, '{}'::jsonb) || jsonb_build_object('source',
            'The tool''s wear: its cost over its life (USD 6.00 for 15 min of cutting, memory/Machining) times the minutes of cutting the part takes, No of Uses x Machining Time Min (migration 1162; it was Tool Cost / Tool Life with the life in parts).'),
          updated_at = now()
      WHERE calculator_id = v AND field_name = 'Tool Cost per Part';
      UPDATE public.calculators SET version = COALESCE(version, 1) + 1, updated_at = now() WHERE id = v;
    END IF;
  END LOOP;

  -- Stamping: the impressions a stroke makes, as the workbook computes them (Stamping & Bending!D35), not a fixed 1.
  IF EXISTS (SELECT 1 FROM public.calculator_fields WHERE calculator_id = stamp_cd AND field_name = 'No Of Impressions' AND field_type = 'number') THEN
    UPDATE public.calculator_fields SET display_order = display_order + 6 WHERE calculator_id = stamp_cd AND display_order > 5;
    INSERT INTO public.calculator_fields (calculator_id, field_name, display_label, field_type, unit, default_value, display_order, is_required, input_config) VALUES
      (stamp_cd, 'Coil Width', 'Coil Width (mm)', 'number', 'mm', '500', 5, false, jsonb_build_object('source',
        sm || ', Stamping & Bending sheet D36: Coil Width 500 mm ("System Suggestion / User can change").')),
      (stamp_cd, 'Start End Scrap', 'Start & End Scrap Length (mm)', 'number', 'mm', '20', 6, false, jsonb_build_object('source',
        sm || ', Stamping & Bending sheet D38: Start & End Scrap Length 20 mm ("Default value").')),
      (stamp_cd, 'Unfolded Length', 'Unfolded Length (mm)', 'number', 'mm', NULL, 7, false, '{}'::jsonb),
      (stamp_cd, 'Thickness', 'Thickness (mm)', 'number', 'mm', NULL, 8, false, '{}'::jsonb),
      (stamp_cd, 'Shear Strength', 'Shear Strength (MPa)', 'number', 'MPa', NULL, 9, false, '{}'::jsonb),
      (stamp_cd, 'Part Allowance', 'Part allowance (mm)', 'calculated', 'mm', '0.01 * {Thickness} * sqrt({Shear Strength} / 10) + 10', 10, false, jsonb_build_object('source',
        sm || ', Stamping & Bending sheet D34: Part allowance =0.01*D30*((D51/10)^(1/2))+10, a constant x the thickness x sqrt(shear strength / 10) + 10 mm.'));
    UPDATE public.calculator_fields
    SET field_type = 'calculated', display_order = 11, display_label = 'No. of Impressions',
        default_value = 'floor(({Coil Width} - {Start End Scrap}) / ({Unfolded Length} + {Part Allowance}))',
        input_config = COALESCE(input_config, '{}'::jsonb) || jsonb_build_object('source',
          sm || ', Stamping & Bending sheet D35: No. of Impressions =ROUNDDOWN((D36-D38)/(D28+D34),0), (coil width - start and end scrap) / (part length + part allowance), 7 for the sheet''s example. Was a fixed 1.'),
        updated_at = now()
    WHERE calculator_id = stamp_cd AND field_name = 'No Of Impressions';
    UPDATE public.calculators SET version = COALESCE(version, 1) + 1, updated_at = now() WHERE id = stamp_cd;
  END IF;

  -- Ultrasonic cleaning and surface treatment: the lot is the annual volume over 12, as the workbook computes it.
  FOREACH v IN ARRAY ARRAY[ultra1, ultra2, surf1, surf2] LOOP
    o := NULL;
    SELECT display_order INTO o FROM public.calculator_fields WHERE calculator_id = v AND field_name = 'Lot Size' AND field_type = 'number';
    IF o IS NOT NULL THEN
      UPDATE public.calculator_fields SET display_order = display_order + 1 WHERE calculator_id = v AND display_order >= o;
      INSERT INTO public.calculator_fields (calculator_id, field_name, display_label, field_type, unit, default_value, display_order, is_required, input_config)
      VALUES (v, 'Annual Volume', 'Annual Volume (#)', 'number', 'pcs/yr', NULL, o, false, '{}'::jsonb);
      UPDATE public.calculator_fields
      SET field_type = 'calculated', default_value = '{Annual Volume} / 12', display_label = 'Lot size (#)',
          input_config = COALESCE(input_config, '{}'::jsonb) || jsonb_build_object('source', lot_source), updated_at = now()
      WHERE calculator_id = v AND field_name = 'Lot Size';
      UPDATE public.calculators SET version = COALESCE(version, 1) + 1, updated_at = now() WHERE id = v;
    END IF;
  END LOOP;

  -- Shot weight: the runner diameter from the part's weight and the runner's length, at least 1.5 x the wall, not a fixed 7 mm.
  IF EXISTS (SELECT 1 FROM public.calculator_fields WHERE calculator_id = shot AND field_name = 'Runner Dia' AND field_type = 'number') THEN
    UPDATE public.calculator_fields SET display_order = display_order + 2 WHERE calculator_id = shot AND display_order >= 5;
    INSERT INTO public.calculator_fields (calculator_id, field_name, display_label, field_type, unit, default_value, display_order, is_required, input_config)
    VALUES (shot, 'Wall Thickness', 'Wall Thickness', 'number', 'mm', NULL, 5, false, '{}'::jsonb);
    UPDATE public.calculator_fields SET display_order = 6 WHERE calculator_id = shot AND field_name = 'Runner Length/Part 1';
    UPDATE public.calculator_fields
    SET field_type = 'calculated', display_order = 7,
        default_value = 'max(sqrt({Finished Part Weight}) * {Runner Length/Part 1} ^ 0.25 / 3.7, 1.5 * {Wall Thickness})',
        input_config = COALESCE(input_config, '{}'::jsonb) || jsonb_build_object('source',
          'Closest published basis (no published source states a fixed runner diameter): D = sqrt(W) x L^0.25 / 3.7, W the part weight in g and L the runner length in mm (Pye, Injection Mould Design; for mouldings up to 200 g with walls under 3 mm), at least 1.5 x the part''s wall (Beaumont, "How to properly size a runner system": "a minimum runner diameter is estimated as being 1.5x the wall thickness of the plastic part"). Was a fixed 7 mm; memory/ bounds runners at 2.032-12.7 mm.'),
        updated_at = now()
    WHERE calculator_id = shot AND field_name = 'Runner Dia';
    UPDATE public.calculators SET version = COALESCE(version, 1) + 1, updated_at = now() WHERE id = shot;
  END IF;

  -- A default and where it comes from; the value, label and unit are left as they are when null.
  CREATE TEMP TABLE m1162_defaults (calculator_id uuid, field_name text, val text, label text, unit text, source text) ON COMMIT DROP;

  INSERT INTO m1162_defaults VALUES
    (bend_cd, 'Direct Labors', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D93: # of Direct Labors 1 ("Lookup from machine database"); the machine''s own crew fills it when its record has one.'),
    (bend_cd, 'Skilled Labors', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D94: # of Skilled Labors, "if no value in machine database default value is 1" (the sheet''s example machine has 0).'),
    (bend_cd, 'Direct Labor Rate', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D95: Direct Labor Rate 30 /hr ("Lookingup Value from the country table"); the location''s labour rate fills it.'),
    (bend_cd, 'Skilled Labor Rate', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D96: Skilled Labor Rate 45 /hr ("Lookingup Value from the country table").'),
    (bend_cd, 'QA Inspector Rate', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D97: QA Inspector Rate 50 /hr.'),
    (bend_cd, 'Sampling Rate', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D98: Sampling Rate 0.01, 1 % ("Look up the sampling plan table based on lot size").'),
    (bend_cd, 'Inspection Time', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D99: Inspection time 0.5 min.'),
    (bend_cd, 'Yield', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D100: Yield (Net Good Parts) 0.98, 98 % ("Default: 98% user can change the value").'),
    (bend_cd, 'Machine Hour Rate', NULL, NULL, NULL, sm || ', TPP sheet''s bending block (Manufacturing 2) D101: Machine hour Rate 15 $/hr ("Lookup from machine database"); the machine''s own rate fills it.'),
    (df_cd, 'Direct Labors', NULL, NULL, NULL, sm || ', DrawingForming sheet D68: # of Direct Labors 1 ("Lookup from machine database"); the machine''s own crew fills it when its record has one.'),
    (df_cd, 'Skilled Labors', NULL, NULL, NULL, sm || ', DrawingForming sheet D69: # of Skilled Labors 1 ("if no value in machine database default value is 1").'),
    (df_cd, 'Direct Labor Rate', NULL, NULL, NULL, sm || ', DrawingForming sheet D70: Direct Labor Rate 30 /hr ("Lookingup Value from the country table"); the location''s labour rate fills it.'),
    (df_cd, 'Skilled Labor Rate', NULL, NULL, NULL, sm || ', DrawingForming sheet D71: Skilled Labor Rate 45 /hr ("Lookingup Value from the country table").'),
    (df_cd, 'QA Inspector Rate', NULL, NULL, NULL, sm || ', DrawingForming sheet D72: QA Inspector Rate 50 /hr.'),
    (df_cd, 'Sampling Rate', NULL, NULL, NULL, sm || ', DrawingForming sheet D73: Sampling Rate 0.01, 1 % ("Look up the sampling plan table based on lot size").'),
    (df_cd, 'Inspection Time', NULL, NULL, NULL, sm || ', DrawingForming sheet D74: Inspection time 0.5 min.'),
    (df_cd, 'Yield', NULL, NULL, NULL, sm || ', DrawingForming sheet D75: Yield (Net Good Parts) 0.98, 98 % ("Default: 98% user can change the value").'),
    (df_cd, 'Machine Hour Rate', NULL, NULL, NULL, sm || ', DrawingForming sheet D76: Machine hour Rate 15 $/hr ("Lookup from machine database"); the machine''s own rate fills it.'),
    (laser_cd, 'Direct Labors', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D63: # of Direct Labors 0.5 ("Lookup from machine database"); the machine''s own crew fills it when its record has one.'),
    (laser_cd, 'Skilled Labors', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D64: # of Skilled Labors, "if no value in machine database default value is 1" (the sheet''s example machine has 0).'),
    (laser_cd, 'Direct Labor Rate', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D65: Direct Labor Rate 30 /hr ("Lookingup Value from the country table"); the location''s labour rate fills it.'),
    (laser_cd, 'Skilled Labor Rate', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D66: Skilled Labor Rate 45 /hr ("Lookingup Value from the country table").'),
    (laser_cd, 'QA Inspector Rate', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D67: QA Inspector Rate 50 /hr.'),
    (laser_cd, 'Sampling Rate', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D68: Sampling Rate 0.01, 1 % ("Look up the sampling plan table based on lot size").'),
    (laser_cd, 'Inspection Time', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D69: Inspection time 0.5 min.'),
    (laser_cd, 'Yield', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D70: Yield (Net Good Parts) 0.98, 98 % ("Default: 98% user can change the value").'),
    (laser_cd, 'Machine Hour Rate', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D71: Machine hour Rate 30 $/hr ("Lookup from machine database"); the machine''s own rate fills it.'),
    (stamp_cd, 'Direct Labors', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D62: # of Direct Labors 1 ("Lookup from machine database"); the machine''s own crew fills it when its record has one.'),
    (stamp_cd, 'Skilled Labors', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D63: # of Skilled Labors 1 ("if no value in machine database default value is 1").'),
    (stamp_cd, 'Direct Labor Rate', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D64: Direct Labor Rate 30 /hr ("Lookingup Value from the country table"); the location''s labour rate fills it.'),
    (stamp_cd, 'Skilled Labor Rate', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D65: Skilled Labor Rate 45 /hr ("Lookingup Value from the country table").'),
    (stamp_cd, 'QA Inspector Rate', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D66: QA Inspector Rate 50 /hr.'),
    (stamp_cd, 'Sampling Rate', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D67: Sampling Rate 0.01, 1 % ("Look up the sampling plan table based on lot size").'),
    (stamp_cd, 'Inspection Time', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D68: Inspection time 0.5 min.'),
    (stamp_cd, 'Yield', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D69: Yield (Net Good Parts) 0.98, 98 % ("Default: 98% user can change the value").'),
    (stamp_cd, 'Machine Hour Rate', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D70: Machine hour Rate 15 $/hr ("Lookup from machine database"); the machine''s own rate fills it.'),
    (tpp_cd, 'Direct Labors', '0.5', NULL, NULL, sm || ', TPP sheet D61: # of Direct Labors 0.5 ("Lookup from machine database"; a turret punch is half an operator). It was 1, which doubled the line''s labour; the machine''s own crew fills it when its record has one.'),
    (tpp_cd, 'Skilled Labors', NULL, NULL, NULL, sm || ', TPP sheet D62: # of Skilled Labors, "if no value in machine database default value is 1" (the sheet''s example machine has 0).'),
    (tpp_cd, 'Direct Labor Rate', NULL, NULL, NULL, sm || ', TPP sheet D63: Direct Labor Rate 30 /hr ("Lookingup Value from the country table"); the location''s labour rate fills it.'),
    (tpp_cd, 'Skilled Labor Rate', NULL, NULL, NULL, sm || ', TPP sheet D64: Skilled Labor Rate 45 /hr ("Lookingup Value from the country table").'),
    (tpp_cd, 'QA Inspector Rate', NULL, NULL, NULL, sm || ', TPP sheet D65: QA Inspector Rate 50 /hr.'),
    (tpp_cd, 'Sampling Rate', NULL, NULL, NULL, sm || ', TPP sheet D66: Sampling Rate 0.01, 1 % ("Look up the sampling plan table based on lot size").'),
    (tpp_cd, 'Inspection Time', NULL, NULL, NULL, sm || ', TPP sheet D67: Inspection time 0.5 min.'),
    (tpp_cd, 'Yield', NULL, NULL, NULL, sm || ', TPP sheet D68: Yield (Net Good Parts) 0.98, 98 % ("Default: 98% user can change the value").'),
    (tpp_cd, 'Machine Hour Rate', NULL, NULL, NULL, sm || ', TPP sheet D69: Machine hour Rate 15 $/hr ("Lookup from machine database"); the machine''s own rate fills it.'),
    (df_cd, 'No Of Impressions', NULL, NULL, NULL, sm || ', DrawingForming sheet D35: No. of Impressions =ROUNDDOWN((D36-D38)/(D28+D34),0), 1 for the sheet''s drawn part (a 300 mm sheet). A drawn part is usually one a stroke; type the part''s own count.'),
    (bend_mfg, 'Process Type', NULL, NULL, NULL, sm || ', TPP sheet D76: Process Type Bending.'),
    (bend_mfg, 'Bending Coefficient', NULL, NULL, NULL, sm || ', TPP sheet D80: Bending coefficient 1.33 ("Constant"; the same on the other sheets). MISUMI gives C1 = 1.33 at a die shoulder width of 8 x the thickness, the width the engine seeds (misumi-techcentral.com, press forming force: bending force).'),
    (bend_mfg, 'Machine Automation', NULL, NULL, NULL, sm || ', TPP sheet D87: M/c Automation Manual (a press brake).'),
    (bend_mfg, 'Direct Labors', NULL, NULL, NULL, sm || ', TPP sheet D93: # Direct Labors 1 ("Lookup from machine database").'),
    (bend_mfg, 'Skilled Labors', NULL, NULL, NULL, sm || ', TPP sheet D94: # of Skilled Labors, "if no value in machine database default value is 1" (the sheet''s example machine has 0).'),
    (df_mfg, 'Process Type', NULL, NULL, NULL, sm || ', DrawingForming sheet: the process the sheet costs (its Process Type cell D49 reads Stamping, copied from the stamping sheet).'),
    (df_mfg, 'Machine Automation', NULL, NULL, NULL, sm || ', DrawingForming sheet D62: M/c Automation Manual.'),
    (df_mfg, 'Direct Labors', NULL, NULL, NULL, sm || ', DrawingForming sheet D68: # of Direct Labors 1 ("Lookup from machine database").'),
    (df_mfg, 'Skilled Labors', NULL, NULL, NULL, sm || ', DrawingForming sheet D69: # of Skilled Labors 1 ("if no value in machine database default value is 1").'),
    (laser_mfg, 'Process Type', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D49: Process Type Laser Cutting.'),
    (laser_mfg, 'Machine Automation', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D58: M/c Automation Auto ("Lookup from machine database").'),
    (laser_mfg, 'Direct Labors', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D63: # of Direct Labors 0.5 ("Lookup from machine database").'),
    (stamp_mfg, 'Process Type', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D49: Process Type Stamping.'),
    (stamp_mfg, 'Machine Automation', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D56: M/c Automation Auto ("Lookup from machine database").'),
    (stamp_mfg, 'Direct Labors', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D62: # Direct Labors 1 ("Lookup from machine database").'),
    (stamp_mfg, 'Skilled Labors', NULL, NULL, NULL, sm || ', Stamping & Bending sheet D63: # of Skilled Labors 1 ("if no value in machine database default value is 1").'),
    (tpp_info, 'Category', NULL, NULL, NULL, sm || ', TPP sheet D22: Category Ferrous, the sheet''s example ("To be captured from part drawing / User Input"); the part''s own material fills it.'),
    (tpp_info, 'Density (g/cc)', NULL, NULL, NULL, sm || ', TPP sheet D25: Density 7.85 g/cc ("Lookup material table"), the example''s steel; the part''s material record fills it.'),
    (tpp_info, 'Material price ($/Kg)', NULL, NULL, NULL, sm || ', TPP sheet D26: Material price 1.5 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (tpp_info, 'Scrap price ($/Kg)', NULL, NULL, NULL, sm || ', TPP sheet D27: Scrap price 0.4 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (tpp_info, 'Scrap Recovery %', NULL, NULL, NULL, sm || ', TPP sheet D45: Scrap Recovery 0.9, 90 % ("Default / User can change").'),
    (tpp_info, 'Sheet Width (mm)', NULL, NULL, NULL, sm || ', TPP sheet D36: Sheet Width 1250 mm ("System Suggestion / User can change").'),
    (tpp_info, 'Sheet Length (mm)', NULL, NULL, NULL, sm || ', TPP sheet D37: Sheet Length 2500 mm ("System Suggestion / User can change").'),
    (tpp_info, 'Edge Allowance (mm)', NULL, NULL, NULL, sm || ', TPP sheet D38: Edge Allowance 2 mm ("Default value").'),
    (laser_info, 'Category', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D22: Category Ferrous, the sheet''s example ("To be captured from part drawing / User Input"); the part''s own material fills it.'),
    (laser_info, 'Family', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D23: Family HDG Steel, the sheet''s example ("To be captured from part drawing"); the part''s own material fills it.'),
    (laser_info, 'Density', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D25: Density 7.85 g/cc ("Lookup material table"), the example''s steel; the part''s material record fills it.'),
    (laser_info, 'Material Price', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D26: Material price 1.5 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (laser_info, 'Scrap Price', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D27: Scrap price 0.4 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (laser_info, 'Scrap Recovery', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D45: Scrap Recovery 0.9, 90 % ("Default / User can change").'),
    (laser_info, 'Part Allowance', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D34: Part allowance (Kerf) 1.0 mm ("Lookup table 5").'),
    (laser_info, 'Sheet Width', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D36: Sheet Width 1250 mm ("System Suggestion / User can change").'),
    (laser_info, 'Sheet Length', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D37: Sheet Length 2500 mm ("System Suggestion / User can change").'),
    (laser_info, 'Edge Allowance', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D38: Edge Allowance 2 mm ("Default value").'),
    (wj_info, 'Category', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D22: Category Ferrous, the sheet''s example ("To be captured from part drawing / User Input"); the part''s own material fills it.'),
    (wj_info, 'Family', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D23: Family HDG Steel, the sheet''s example ("To be captured from part drawing"); the part''s own material fills it.'),
    (wj_info, 'Density', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D25: Density 7.85 g/cc ("Lookup material table"), the example''s steel; the part''s material record fills it.'),
    (wj_info, 'Material Price', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D26: Material price 1.5 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (wj_info, 'Scrap Price', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D27: Scrap price 0.4 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (wj_info, 'Scrap Recovery', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D45: Scrap Recovery 0.9, 90 % ("Default / User can change").'),
    (wj_info, 'Part Allowance', '0.76', NULL, NULL, 'The waterjet kerf: OMAX, "the kerf normally equals the width of the mixing tube used in the nozzle assembly", a 0.030 in (0.76 mm) tube (knowledgebase.omax.com, ProtoMAX terminology); OMAX measures 0.021-0.060 in (0.53-1.52 mm). The field is the kerf, as the laser sheet''s "Part allowance : (Kerf)". Was 0.9 mm, unsourced (migration 399).'),
    (wj_info, 'Sheet Width', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D36: Sheet Width 1250 mm (the workbook has no waterjet sheet; its laser sheet''s material block, as migration 399 copied it).'),
    (wj_info, 'Sheet Length', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D37: Sheet Length 2500 mm (as migration 399 copied it from the laser sheet).'),
    (wj_info, 'Edge Allowance', NULL, NULL, NULL, sm || ', Cutting (Laser) sheet D38: Edge Allowance 2 mm (as migration 399 copied it from the laser sheet).'),
    (df_info, 'Category', NULL, NULL, NULL, sm || ', DrawingForming sheet D22: Category Ferrous, the sheet''s example ("To be captured from part drawing / User Input"); the part''s own material fills it.'),
    (df_info, 'Family', NULL, NULL, NULL, sm || ', DrawingForming sheet D23: Family HDG Steel, the sheet''s example ("To be captured from part drawing"); the part''s own material fills it.'),
    (df_info, 'Density', NULL, NULL, NULL, sm || ', DrawingForming sheet D25: Density 7.85 g/cc ("Lookup material table"), the example''s steel; the part''s material record fills it.'),
    (df_info, 'Material Price', NULL, NULL, NULL, sm || ', DrawingForming sheet D26: Material price 1.5 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (df_info, 'Scrap Price', NULL, NULL, NULL, sm || ', DrawingForming sheet D27: Scrap price 0.4 $/Kg ("Lookup material table"); the part''s material record fills it.'),
    (df_info, 'Scrap Recovery', NULL, NULL, NULL, sm || ', DrawingForming sheet D45: Scrap Recovery 0.9, 90 % ("Default / User can change").'),
    (df_info, 'Coil Width', NULL, NULL, NULL, sm || ', DrawingForming sheet D36: Coil/Sheet Width 300 mm ("System Suggestion / User can change").'),
    (df_info, 'Coil Length', NULL, NULL, NULL, sm || ', DrawingForming sheet D37: Coil/Sheet Length 300 mm ("System Suggestion / User can change").'),
    (df_info, 'Start End Scrap', NULL, NULL, NULL, sm || ', DrawingForming sheet D38: Start & End Scrap Length 5 mm ("Default value").'),
    (gross, 'Edge Allowance', NULL, NULL, NULL, sm || ', TPP sheet D38 (and Cutting (Laser) sheet D38): Edge Allowance 2 mm ("Default value").'),
    (gross, 'Flat Pattern Outline', NULL, NULL, NULL, 'Not a value: a placeholder saying the CAD flat pattern fills this field (the engine reads the outline from the part''s CAD).'),
    (cbore, 'OLE', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (cbore, 'Setup Percentage', NULL, NULL, NULL, mw || ', Facing sheet C13: Setup Percentage 30 % (the Knurling and Threading sheets use 15 %).'),
    (csink, 'OLE', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (csink, 'Setup Percentage', NULL, NULL, NULL, mw || ', Facing sheet C13: Setup Percentage 30 % (the Knurling and Threading sheets use 15 %).'),
    (burr, 'OLE', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (burr, 'Setup Percentage', NULL, NULL, NULL, mw || ', Facing sheet C13: Setup Percentage 30 % (the Knurling and Threading sheets use 15 %).'),
    (pem1, 'OLE', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (pem1, 'Setup Percentage', NULL, NULL, NULL, mw || ', Facing sheet C13: Setup Percentage 30 % (the Knurling and Threading sheets use 15 %).'),
    (pem2, 'OLE', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (pem2, 'Setup Percentage', NULL, NULL, NULL, mw || ', Facing sheet C13: Setup Percentage 30 % (the Knurling and Threading sheets use 15 %).'),
    (deburr, 'OLE', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (roll, 'OLE', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C14): OLE 80 %.'),
    (deburr, 'Setup Cost', NULL, NULL, NULL, 'No published source is needed: deburring charges no setup (the engine''s deburring line has none), so 0 is the definition.'),
    (burr, 'No Of Extrusions', NULL, NULL, NULL, 'A placeholder: the part''s CAD fills the count of extruded holes; 1 is no reference value.'),
    (pem1, 'No Of Insertions', NULL, NULL, NULL, 'A placeholder: the part''s BOM and CAD fill the count of inserts; 1 is no reference value.'),
    (pem2, 'No Of Insertions', NULL, NULL, NULL, 'A placeholder: the part''s BOM and CAD fill the count of inserts; 1 is no reference value.'),
    (cbore, 'Tool Code', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C9): Tool code 0.'),
    (cbore, 'No of Uses', NULL, NULL, NULL, mw || ', Knurling sheet K4: No of uses 1. The engine fills it with the holes of each diameter.'),
    (cbore, 'Tool Cost', '6', 'Tool Cost ($ per tool life)', '$', 'The tool''s wear over its life: memory/Machining/lookup/tblCounterboring__rows.csv, counterbore (Virtual Carbide and Virtual HSS Counterbore): tool_life_cost_usd 6.0 per tool_life_min 15, USD 6.00 for 15 minutes of cutting. A tool''s price for comparison: Yankee 301-1/4 HSS counterbore USD 44.29 (zoro.com), Addison HSS counterbore Rs 1,651-2,359 (industrybuying.com). Was 0 (no tool cost).'),
    (cbore, 'Tool Life', '15', 'Tool Life (min of cutting)', 'min', 'memory/Machining/lookup/tblCounterboring__rows.csv: tool_life_min 15, minutes of cutting (Machinery''s Handbook 31st ed. p. 1093 gives an economic life of about 45 min for drilling and milling tools). In minutes since migration 1162, so the tool cost per part is the tool cost x the cutting minutes the part takes / the life; it was in parts, 0.'),
    (cbore, 'Approach Time', NULL, NULL, NULL, 'Closest published basis: the spindle start of a machining centre, Numeryx An-101 (numeryx.com/cnc/drilling51.htm), "at 2000 rpm the accel time is 1 sec", as the tapping cycle''s approach (TAP_APPROACH_SEC, migration 1159).'),
    (cbore, 'Retract Time', NULL, NULL, NULL, 'Closest published basis: the spindle stop of a machining centre, Numeryx An-101, "at 2000 rpm the accel time is 1 sec", as the tapping cycle''s unload (TAP_UNLOAD_SEC, migration 1159).'),
    (cbore, 'Tool Change Time', NULL, NULL, NULL, 'No published source found for a drill press''s tool change (3 s kept). A machining centre''s is 4.2 s (Haas VF-2 tool-to-tool), the tapping cycle''s since migration 1159.'),
    (csink, 'Tool Code', NULL, NULL, NULL, mw || ', every sheet''s cost block (Facing sheet C9): Tool code 0.'),
    (csink, 'No of Uses', NULL, NULL, NULL, mw || ', Knurling sheet K4: No of uses 1. The engine fills it with the holes of each diameter.'),
    (csink, 'Tool Cost', '6', 'Tool Cost ($ per tool life)', '$', 'The tool''s wear over its life: memory/Machining/lookup/tblChamfering__rows.csv, corner chamfering mill, the nearest to a countersink (the reference export has no countersink table): tool_life_cost_usd 6.0 per tool_life_min 15, USD 6.00 for 15 minutes of cutting. A tool''s price for comparison: Keo 917-000-024 HSS 90 deg countersink USD 24.79 (zoro.com), Addison HSS countersink Rs 2,713-6,371 (industrybuying.com). Was 0 (no tool cost).'),
    (csink, 'Tool Life', '15', 'Tool Life (min of cutting)', 'min', 'memory/Machining/lookup/tblChamfering__rows.csv: tool_life_min 15, minutes of cutting (Machinery''s Handbook 31st ed. p. 1093 gives an economic life of about 45 min for drilling and milling tools). In minutes since migration 1162, so the tool cost per part is the tool cost x the cutting minutes the part takes / the life; it was in parts, 0.'),
    (csink, 'Approach Time', NULL, NULL, NULL, 'Closest published basis: the spindle start of a machining centre, Numeryx An-101 (numeryx.com/cnc/drilling51.htm), "at 2000 rpm the accel time is 1 sec", as the tapping cycle''s approach (TAP_APPROACH_SEC, migration 1159).'),
    (csink, 'Retract Time', NULL, NULL, NULL, 'Closest published basis: the spindle stop of a machining centre, Numeryx An-101, "at 2000 rpm the accel time is 1 sec", as the tapping cycle''s unload (TAP_UNLOAD_SEC, migration 1159).'),
    (csink, 'Tool Change Time', NULL, NULL, NULL, 'No published source found for a drill press''s tool change (3 s kept). A machining centre''s is 4.2 s (Haas VF-2 tool-to-tool), the tapping cycle''s since migration 1159.'),
    (insp, 'Method', NULL, NULL, NULL, 'No published source found for a default method: the metrology rule of ten (a gauge resolving a tenth of the tolerance) picks it from the drawing tolerance. The engine sets visual unless the drawing''s tolerances or GD&T escalate it (inspection-engine.ts).'),
    (insp, 'Visual Pass Base', NULL, NULL, NULL, 'A placeholder: the engine fills the visual pass time from inspection_operation_defaults for the part''s method, each row with its source (migration 1163).'),
    (insp, 'Hole Check Time', NULL, NULL, NULL, 'A placeholder: the engine fills the hole check time from inspection_operation_defaults for the part''s method, each row with its source (migration 1163).'),
    (insp, 'Bend Check Time', NULL, NULL, NULL, 'A placeholder: the engine fills the bend check time from inspection_operation_defaults for the part''s method, each row with its source (migration 1163).'),
    (insp, 'Thread Gauge Time', NULL, NULL, NULL, 'A placeholder: the engine fills the thread gauge time from inspection_operation_defaults for the part''s method, each row with its source (migration 1163).'),
    (insp, 'Thickness Check Time', NULL, NULL, NULL, 'A placeholder: the engine fills the thickness check time from inspection_operation_defaults for the part''s method, each row with its source (migration 1163).'),
    (insp, 'Dimension Check Time', NULL, NULL, NULL, 'A placeholder: the engine fills the dimension check time from inspection_operation_defaults for the part''s method, each row with its source (migration 1163).'),
    (insp, 'Holes to Inspect', NULL, NULL, NULL, 'A placeholder: the engine fills the holes to check from the part''s CAD and the AQL sampling plan (sm_lookup_sampling_plan).'),
    (insp, 'Bends to Inspect', NULL, NULL, NULL, 'A placeholder: the engine fills the bends to check from the part''s CAD and the AQL sampling plan (sm_lookup_sampling_plan).'),
    (insp, 'Threads to Inspect', NULL, NULL, NULL, 'A placeholder: the engine fills the threads to check from the part''s CAD and the AQL sampling plan (sm_lookup_sampling_plan).'),
    (insp, 'Has Thickness Check', NULL, NULL, NULL, 'A placeholder: the engine sets 1 when the part has a sheet thickness to check.'),
    (insp, 'Has Dimension Check', NULL, NULL, NULL, 'A placeholder: the engine sets 1 when the part has overall dimensions to check.'),
    (ultra1, 'MHR per Hour', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C7: MHR/hour 91.6, INR an hour in India (MHR city India).'),
    (ultra1, 'LHR per Hour', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C8: LHR/hour 96.14, INR an hour in India (96.14 on every sheet).'),
    (ultra1, 'OLE', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C14: OLE 80 %.'),
    (ultra1, 'Setup Percentage', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C13: Setup Percentage 30 %.'),
    (ultra2, 'MHR per Hour', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C7: MHR/hour 91.6, INR an hour in India (MHR city India).'),
    (ultra2, 'LHR per Hour', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C8: LHR/hour 96.14, INR an hour in India (96.14 on every sheet).'),
    (ultra2, 'OLE', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C14: OLE 80 %.'),
    (ultra2, 'Setup Percentage', NULL, NULL, NULL, mw || ', RM Composition Analysis sheet C13: Setup Percentage 30 %.'),
    (laser_time, 'machine_rate', NULL, NULL, NULL, 'A placeholder: the laser''s own machine hour rate fills it.'),
    (laser_time, 'labour_rate', NULL, NULL, NULL, 'A placeholder: the operator''s labour rate for the location fills it.'),
    (laser_time, 'setup_time', NULL, NULL, NULL, 'No published source found for 15 min (kept). The Sheet Metal workbook does not fix a setup: it is the sheet loading time over the lot, Cutting (Laser) sheet D59 =D60/D16 with D60 =ROUNDUP(D16/D39,0)*10 min a sheet.'),
    (laser_time, 'perimeter_mm', NULL, NULL, NULL, 'A placeholder: the part''s CAD cut perimeter fills it.'),
    (laser_time, 'pierce_count', NULL, NULL, NULL, 'memory/Sheetmetal/laser_cutting_costing_params (1).md: No. of Piercing 1; a placeholder the part''s CAD (its starts) fills (the Sheet Metal workbook''s example has 2, Cutting (Laser) sheet D51).'),
    (laser_time, 'machine_speed_mm_per_min', '4200', NULL, NULL, sm || ', Cutting (Laser) sheet D52: Cutting Speed 4.2 m/min ("Lookup Table 5"); the Machining workbook''s Laser Cutting sheet K25 gives Laser 2 Axis, 2 mm: 4200 mm/min (3 mm: 4100, K26). Was 4000 ("3 mm MS fiber 3 kW", no source).'),
    (laser_time, 'pierce_time_sec_each', '1.2', NULL, NULL, sm || ', Cutting (Laser) sheet D54: Piercing Time =0.02*D51 min, 0.02 min = 1.2 s a pierce. Was 1.5 s, no source (memory/Sheetmetal/laser_cutting_costing_params (1).md gives 2 s for a 2 kW stainless example).'),
    (shot, 'No of Cavity', NULL, NULL, NULL, 'memory/Plastic Modeling/variables/digital_factory_variables.csv: defaultNumCavities 1, "Default value for the number of cavities in one mold".'),
    (tonnage, 'Saftey factor', '1.1', NULL, NULL, 'memory/Plastic Modeling/variables/digital_factory_variables.csv: clampForceSafetyFactor 1.1, "Multiplier of clamp pressure required to ensure that the machine is capable of applying the necessary mold pressure (10% safety factor)", the value the injection engine sizes its press with. Was 1.2, no source (Autodesk Moldflow keeps the clamp force under about 80 % of the machine, 1.25).');

  -- The new inputs the part fills: where each value comes from.
  INSERT INTO m1162_defaults VALUES
    (stamp_cd, 'Unfolded Length', NULL, NULL, NULL, 'The part''s unfolded (flat) length fills it, Stamping & Bending sheet D28 ("To be captured from part drawing / User Input").'),
    (stamp_cd, 'Thickness', NULL, NULL, NULL, 'The part''s sheet thickness fills it, Stamping & Bending sheet D30 ("To be captured from part drawing / User Input").'),
    (stamp_cd, 'Shear Strength', NULL, NULL, NULL, 'The part''s material shear strength fills it, Stamping & Bending sheet D51 ("Lookup material table").'),
    (ultra1, 'Annual Volume', NULL, NULL, NULL, 'The part''s annual volume fills it (Stamping & Bending sheet D8, "Populated from template upload / User Input").'),
    (ultra2, 'Annual Volume', NULL, NULL, NULL, 'The part''s annual volume fills it (Stamping & Bending sheet D8, "Populated from template upload / User Input").'),
    (surf1, 'Annual Volume', NULL, NULL, NULL, 'The part''s annual volume fills it (Stamping & Bending sheet D8, "Populated from template upload / User Input").'),
    (surf2, 'Annual Volume', NULL, NULL, NULL, 'The part''s annual volume fills it (Stamping & Bending sheet D8, "Populated from template upload / User Input").'),
    (shot, 'Wall Thickness', NULL, NULL, NULL, 'The part''s nominal wall thickness fills it (CAD), for the runner''s minimum diameter, 1.5 x the wall (Beaumont).');

  UPDATE public.calculator_fields f
  SET default_value = COALESCE(d.val, f.default_value),
      display_label = COALESCE(d.label, f.display_label),
      unit = COALESCE(d.unit, f.unit),
      input_config = COALESCE(f.input_config, '{}'::jsonb) || jsonb_build_object('source', d.source),
      updated_at = now()
  FROM m1162_defaults d
  WHERE f.calculator_id = d.calculator_id AND f.field_name = d.field_name;
END
$m$;

-- Post-check: every default of these calculators that is present (an input's value, or a constant written as a formula) has its source.
DO $post$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(c.name || ': ' || f.field_name, ', ') INTO bad
  FROM public.calculator_fields f JOIN public.calculators c ON c.id = f.calculator_id
  WHERE c.id IN ('4e738d77-b818-4c2a-8d44-2e71cbde4d7b', '102772ff-5422-45c1-b391-6d2d4a96ab1b', 'edccd27a-c91c-479d-a440-d00053249a3a',
      '0f7d6451-3937-472d-9a4c-3f8f3ebf59d8', 'cc4291f1-15fc-4038-88bc-c74c3480f168', '74abe76f-5f27-4600-9369-07576d481f73',
      '966fff11-5b69-44bc-ad55-6645f1df223c', '432d6322-dca7-4664-90a4-332d594ed684', 'ecf632c6-5ff3-40a5-b392-0b8c646c79c2',
      'e7eae3f2-b221-475d-b82b-8b5fb0592a6d', '5f7a6110-5f2f-400d-be79-982894aa7f89', 'f8537846-b0eb-4d49-9cfb-a93f6b9e2c63',
      '97d947bd-fb5a-477b-af35-d3eb2c938983', '72f84130-a741-425f-8fa9-9b027541801c', '9cbf2166-07be-4070-8e00-0b6c5075f71e',
      '450d3468-70b2-41cc-924e-ffe1b17952f7', 'e12094c7-cdfd-4dde-a153-1f98a5250a72', '0c841b0a-2eaf-4482-9654-9ff366f07fa2',
      'b4beb74f-bf03-4637-8c83-01acb8c18177', '3dc73e27-8397-4715-980a-a7b1cf9eb0e0', 'd82a0a57-ced8-4428-9f97-c11604ce8e39',
      '3c9ad24c-952a-48d4-beda-66507961ee0d', '6c32140d-ffc1-44b3-a744-a354da813928', '0bbea0e0-8f1b-445c-b23d-a194cf8270e9',
      'a3935f86-ea9f-4272-96d1-6cc14261513a', '664cb15f-66dd-460d-86c6-7684075147ea', '34f8dff4-d20f-4707-97a8-27fceca29b04',
      '3020005f-2dea-40f0-93ad-540c2670cebd', '08664969-fa5e-4f5b-a1bd-e847de9dc3dd')
    AND COALESCE(f.default_value, '') <> ''
    AND (f.field_type <> 'calculated' OR f.default_value ~ '^\s*-?[0-9.]+\s*$')
    AND NOT (COALESCE(f.input_config, '{}'::jsonb) ? 'source');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 1162: defaults without a source: %', bad;
  END IF;
END
$post$;

COMMIT;
