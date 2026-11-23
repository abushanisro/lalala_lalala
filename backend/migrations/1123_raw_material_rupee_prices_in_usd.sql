-- ============================================================================
-- Migration 1123: two material prices entered in rupees and yuan are stated in USD per kg, as every other price is
-- ============================================================================
-- raw_materials' location prices hold USD per kg (migration 350; 510 of the 512 rows). The costing now reads them so and converts
-- them to the quote's currency. Two rows were entered in local currency, and would now price about 94 times too high in India:
--
--   304 (SS304)                   cost_india and cost = 190: migration 422 entered "Rs 190/kg" (2026 regional steel trade reports).
--   Generic Aluminum, ANSI 6101   cost_india = 296: migration 463 entered "Rs 296/kg" (a cited 6101-T6 listing, 2026-08-10).
--                                 cost_china = 18.22: migration 463 converted its USD source, 2.70, to yuan at 6.7476.
--
-- Each cited value is kept and converted, not replaced:
--   a rupee price is divided by the app's own active budget rate for INR (exchange_rates, 1 USD = rate INR), the same rate a quote
--   in rupees converts back with, so an India quote still shows the price the source states;
--   the yuan price goes back to its stated USD source, 2.70;
--   the 304 row's `cost` (the price used where a location has none) becomes its USA price, 3.40, as on the other rows.
--
-- Only rows still holding the local-currency values are changed, so it runs once. Where neither row is present nothing happens.
-- Where a rupee row is present but no active INR rate is, it fails: a price left in rupees would be read as dollars.
-- ============================================================================

DO $rupees$
DECLARE
  inr numeric;
  pending int;
BEGIN
  SELECT count(*) INTO pending FROM raw_materials
  WHERE (name = '304' AND grade = 'SS304' AND cost_india = 190)
     OR (name = 'Generic Aluminum, ANSI 6101' AND cost_india = 296);
  IF pending = 0 THEN
    RAISE NOTICE 'Migration 1123: no material price in rupees to convert';
  ELSE
    SELECT rate INTO inr FROM exchange_rates
    WHERE from_currency = 'USD' AND to_currency = 'INR' AND is_active AND rate_type = 'budget' AND rate > 0
    ORDER BY effective_date DESC LIMIT 1;
    IF inr IS NULL THEN
      RAISE EXCEPTION 'Migration 1123: % material price(s) are in rupees and exchange_rates has no active budget rate for INR to convert them', pending;
    END IF;

    UPDATE raw_materials SET cost_india = round(190 / inr, 4), cost = cost_usa
    WHERE name = '304' AND grade = 'SS304' AND cost_india = 190;
    UPDATE raw_materials SET cost_india = round(296 / inr, 4)
    WHERE name = 'Generic Aluminum, ANSI 6101' AND cost_india = 296;
    RAISE NOTICE 'Migration 1123: % rupee price(s) converted at 1 USD = % INR', pending, inr;
  END IF;

  UPDATE raw_materials SET cost_china = 2.70
  WHERE name = 'Generic Aluminum, ANSI 6101' AND cost_china = 18.22;
END
$rupees$;
