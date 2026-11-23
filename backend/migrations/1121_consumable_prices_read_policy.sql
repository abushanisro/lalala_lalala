-- ============================================================================
-- Migration 1121: signed-in users read the consumable prices (reference data)
-- ============================================================================
-- consumable_prices (migration 362) holds one price per consumable and location, in USD: today the garnet a waterjet cuts with, per kg.
-- The costing reads it with the signed-in user's own token. The table has row-level security switched on and no policy at all, so that
-- read returned no row for anyone: every waterjet quote left its abrasive out and said no garnet price was on file, while the prices
-- were in the table.
-- The prices are shared reference data with no tenant column, like the electricity prices (migration 1004): every signed-in user reads
-- them, and nobody but the service role writes them (the app has no screen that edits a price).
-- Idempotent.
-- ============================================================================

ALTER TABLE public.consumable_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_consumable_prices ON public.consumable_prices;
CREATE POLICY read_consumable_prices ON public.consumable_prices FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.consumable_prices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.consumable_prices TO authenticated;
