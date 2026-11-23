-- 1121: the consumable prices (a waterjet's garnet) are shared reference data. A signed-in user reads them, with row-level security
-- still on; nobody but the service role writes them; an anonymous caller reads nothing.
-- The stub is the table as the real database has it: security on, no policy, so a signed-in read returned no row before 1121.
DO $$
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.consumable_prices'::regclass), 'row-level security stays on';
  ASSERT has_table_privilege('authenticated', 'public.consumable_prices', 'SELECT'), 'signed-in users read the prices';
  ASSERT NOT has_table_privilege('authenticated', 'public.consumable_prices', 'INSERT'), 'users do not write reference data';
  ASSERT NOT has_table_privilege('authenticated', 'public.consumable_prices', 'UPDATE'), 'users do not change a price';
  ASSERT NOT has_table_privilege('authenticated', 'public.consumable_prices', 'DELETE'), 'users do not delete a price';
  ASSERT NOT has_table_privilege('anon', 'public.consumable_prices', 'SELECT'), 'anonymous callers read nothing';
  ASSERT has_table_privilege('service_role', 'public.consumable_prices', 'UPDATE'), 'the service role still maintains the prices';
END $$;

SET ROLE authenticated;
DO $$
DECLARE n int; price numeric;
BEGIN
  SELECT count(*) INTO n FROM public.consumable_prices WHERE consumable_type = 'garnet_abrasive';
  ASSERT n = 2, 'a signed-in user sees every garnet price, not zero rows';
  SELECT price_per_unit INTO price FROM public.consumable_prices WHERE consumable_type = 'garnet_abrasive' AND location = 'India';
  ASSERT price = 0.48, 'and reads the price of a location';
END $$;
RESET ROLE;
