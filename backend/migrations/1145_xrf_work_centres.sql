-- ============================================================================
-- Migration 1145: the XRF work centre (raw material composition analysis)
-- ============================================================================
-- The machining calculator workbook (memory/Machining - Calculator Database (1).xlsx, sheet RM Composition Analysis) checks each raw
-- material lot's composition on an XRF analyzer, work centre XRF-0000-0001P: 60 s a lot. HR Rates had no XRF work centre anywhere,
-- so the line could not be priced. This adds one, machine class xrf_analyzer, for the two locations HR Rates holds machining machines in
-- (USA and India; China, Mexico and France hold Sheet Metal only). Every rate is in USD per hour, as HR Rates stores them.
--
-- India: the workbook's own work centre, XRF-0000-0001P: MHR 91.6 INR/h (machine) and LHR 96.14 INR/h (labour), converted at the active
--   USD -> INR rate of exchange_rates when the migration runs (93.93 on 2026-11-16, ECB via Frankfurter, migration 1062). The workbook
--   states one machine rate: it is the direct overhead, with no indirect overhead apart from it.
-- USA: no USA rate exists in memory/ or the workbook. The analyzer is priced from the market and its rate built the way the reference
--   builds its inspection station's (memory/machining/machine/inspection_usa.csv, "Default": a USD 5,000 bench, 610 x 610 mm, 10 years,
--   80 % uptime, 5 % maintenance, 20 % installation, no power: direct overhead 0.30, indirect 13.90, labour 43.21 USD/h):
--     machine price      USD 22,990: a new handheld alloy-grade XRF analyzer for machine shops (SciAps X-5 list price, The XRF Company,
--                        shop.xrfcompany.com, November 2026; Alloy Geek's price guide gives USD 20,000-25,000 for an entry-level unit)
--     direct overhead    22,990 x 0.30 / 5,000 = 1.3794 USD/h: the reference station's direct overhead per dollar of machine price, on its
--                        same bottom-up inputs (a battery-powered handheld draws no machine power)
--     indirect overhead  13.90 USD/h: the reference station's own (the same bench footprint)
--     labour             43.21 USD/h: the reference station's inspector (wage grade 4 - Metal)
-- The project owner's decision of 2026-11-24: no gap, the India work centre from the workbook, the rest from research.
--
-- Idempotent: each work centre is matched by location, machine class and name, inserted once and its rates re-set.
-- ============================================================================

DO $xrf$
DECLARE
  inr_per_usd numeric;
BEGIN
  SELECT rate INTO inr_per_usd FROM exchange_rates
   WHERE from_currency = 'USD' AND to_currency = 'INR' AND is_active ORDER BY effective_date DESC LIMIT 1;
  IF inr_per_usd IS NULL OR inr_per_usd <= 0 THEN RAISE EXCEPTION 'XRF work centre: no active USD -> INR rate in exchange_rates'; END IF;

  -- India: the workbook's XRF-0000-0001P.
  INSERT INTO mhr_records (location, machine_name, machine_class, process_group, machine_description, operators, setup_time_hr,
    currency, currency_code, country_code, process_family, source_type, data_version, is_global, availability_status, mhr_source,
    shifts_per_day, hours_per_shift, working_days_per_year, capacity_utilization_rate)
  SELECT 'India', 'XRF-0000-0001P', 'xrf_analyzer', 'Machining',
    'Raw material composition analysis (XRF). Machining calculator workbook, RM Composition Analysis sheet: MHR 91.6 INR/h, LHR 96.14 INR/h, 60 s a lot.',
    1, 0, 'USD', 'USD', 'IN', 'machined', 'BENCHMARK', 'FY2025-26', false, 'available', 'legacy_import', 3, 8, 260, 95
  WHERE NOT EXISTS (SELECT 1 FROM mhr_records WHERE location = 'India' AND machine_class = 'xrf_analyzer' AND machine_name = 'XRF-0000-0001P');
  UPDATE mhr_records SET
    direct_overhead_rate = round(91.6 / inr_per_usd, 4), indirect_overhead_rate = 0,
    total_machine_hour_rate = round(91.6 / inr_per_usd, 4), mhr_usd_per_hour = round(91.6 / inr_per_usd, 4),
    usd_labor_rate_per_hr = round(96.14 / inr_per_usd, 4), usd_lhr_total = round(96.14 / inr_per_usd, 4),
    benchmark_direct_overhead_rate_usd_hr = round(91.6 / inr_per_usd, 4), benchmark_indirect_overhead_rate_usd_hr = 0,
    benchmark_labor_rate_usd_hr = round(96.14 / inr_per_usd, 4), benchmark_source_key = 'Machining workbook: RM Composition Analysis',
    direct_overhead_source = 'imported', indirect_overhead_source = 'imported', labor_rate_source = 'imported', updated_at = now()
  WHERE location = 'India' AND machine_class = 'xrf_analyzer' AND machine_name = 'XRF-0000-0001P';

  -- USA: a handheld alloy-grade XRF analyzer, its rate built as the reference's inspection station's.
  INSERT INTO mhr_records (location, machine_name, machine_class, process_group, machine_description, operators, setup_time_hr,
    currency, currency_code, country_code, process_family, source_type, data_version, is_global, availability_status, mhr_source,
    shifts_per_day, hours_per_shift, working_days_per_year, capacity_utilization_rate, wage_grade, manufacturer_country,
    machine_price_usd, machine_length_mm, machine_width_mm, machine_life_yr, machine_power_kw, machine_uptime_pct,
    annual_maintenance_factor_pct, footprint_allowance_factor, installation_factor_pct, supplies_cost_per_year, salvage_value_factor_pct)
  SELECT 'USA', 'Handheld XRF Alloy Analyzer', 'xrf_analyzer', 'Machining',
    'Raw material composition analysis (XRF), 60 s a lot (machining calculator workbook, RM Composition Analysis). Price: SciAps X-5 new list USD 22,990 (The XRF Company, Nov 2026; Alloy Geek guide USD 20,000-25,000 entry level). Rates built as memory/machining/machine/inspection_usa.csv Default: direct overhead 22,990 x 0.30 / 5,000, indirect 13.90, labour 43.21 USD/h.',
    1, 0, 'USD', 'USD', 'US', 'machined', 'BENCHMARK', 'FY2025-26', false, 'available', 'legacy_import', 3, 8, 260, 95, '4 - Metal', 'USA',
    22990, 610, 610, 10, 0, 80, 5, 2, 20, 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM mhr_records WHERE location = 'USA' AND machine_class = 'xrf_analyzer' AND machine_name = 'Handheld XRF Alloy Analyzer');
  UPDATE mhr_records SET
    direct_overhead_rate = 1.3794, indirect_overhead_rate = 13.90, total_machine_hour_rate = 15.2794, mhr_usd_per_hour = 15.2794,
    usd_labor_rate_per_hr = 43.21, usd_lhr_total = 43.21,
    benchmark_direct_overhead_rate_usd_hr = 1.3794, benchmark_indirect_overhead_rate_usd_hr = 13.90, benchmark_labor_rate_usd_hr = 43.21,
    benchmark_source_key = 'Inspection:Default bottom-up, XRF analyzer USD 22,990',
    direct_overhead_source = 'benchmark', indirect_overhead_source = 'benchmark', labor_rate_source = 'benchmark', updated_at = now()
  WHERE location = 'USA' AND machine_class = 'xrf_analyzer' AND machine_name = 'Handheld XRF Alloy Analyzer';

  IF (SELECT count(*) FROM mhr_records WHERE machine_class = 'xrf_analyzer' AND total_machine_hour_rate > 0 AND usd_lhr_total > 0) <> 2 THEN
    RAISE EXCEPTION 'XRF work centre: expected the India and USA work centres with their rates';
  END IF;
END $xrf$;

NOTIFY pgrst, 'reload schema';
