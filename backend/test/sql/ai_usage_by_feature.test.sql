-- 1166: usage is counted per feature as well; the daily totals the budgets read are unchanged; a member reads the organization's
-- totals per day and feature with their own share, never another organization's, and never another member's own figures.
INSERT INTO auth.users (id) VALUES ('11111111-0000-4000-8000-00000000000a'), ('11111111-0000-4000-8000-00000000000b'), ('11111111-0000-4000-8000-00000000000c');
INSERT INTO public.organizations (id) VALUES ('aaaaaaaa-0000-4000-8000-000000000001'), ('bbbbbbbb-0000-4000-8000-000000000002');

-- Rows from before the migration (949 wrote no feature) and from days gone by.
INSERT INTO public.ai_usage_daily (usage_date, user_id, organization_id, input_tokens, output_tokens, calls) VALUES
  ((now() AT TIME ZONE 'utc')::date - 1,  '11111111-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 700, 70, 3),
  ((now() AT TIME ZONE 'utc')::date - 40, '11111111-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 9000, 900, 9);

\i /migrations/1166_ai_usage_by_feature.sql
\i /migrations/1166_ai_usage_by_feature.sql

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.ai_usage_daily WHERE feature = 'other') = 2, 'rows from before the migration are kept, under other';
  ASSERT (SELECT array_length(conkey, 1) FROM pg_constraint WHERE conrelid = 'public.ai_usage_daily'::regclass AND contype = 'p') = 4,
    'the primary key includes the feature';
END $$;

-- A, in organization A: two copilot calls, one drawing reading, and one call from a backend that names no feature.
SET ROLE authenticated;
SELECT set_config('test.uid', '11111111-0000-4000-8000-00000000000a', false);
SELECT set_config('test.org_ids', 'aaaaaaaa-0000-4000-8000-000000000001', false);
SELECT public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 1000, 200, 'copilot');
SELECT public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 300, 50, 'copilot');
SELECT public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 4000, 600, 'drawing_reading');
SELECT public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 10, 5);

DO $$
DECLARE t record;
BEGIN
  SELECT * INTO t FROM public.ai_usage_today('aaaaaaaa-0000-4000-8000-000000000001');
  ASSERT t.user_tokens = 6165 AND t.organization_tokens = 6165, format('the daily totals sum every feature: %s', t);
  ASSERT (SELECT calls FROM public.ai_usage_daily WHERE feature = 'copilot') = 2, 'one row a feature, two calls (atomic upsert)';
  BEGIN
    PERFORM public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 1, 1, 'Not A Feature');
    RAISE EXCEPTION 'a malformed feature was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 1, 1, NULL);
    RAISE EXCEPTION 'a missing feature was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', -5, 0, 'copilot');
    RAISE EXCEPTION 'a negative amount was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_usage_record('bbbbbbbb-0000-4000-8000-000000000002', 1, 1, 'copilot');
    RAISE EXCEPTION 'A recorded usage for B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- C, another member of A, spends too: A's organization figures hold both, each member's own share only their own.
SELECT set_config('test.uid', '11111111-0000-4000-8000-00000000000c', false);
SELECT public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 2000, 100, 'copilot');
SELECT public.ai_usage_record('aaaaaaaa-0000-4000-8000-000000000001', 500, 50, 'vave');

DO $$
DECLARE
  today date := (now() AT TIME ZONE 'utc')::date;
  r record;
BEGIN
  -- as C, the last 30 days: yesterday's row and today's four features; the row of 40 days ago is outside the window
  ASSERT (SELECT count(*) FROM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 30)) = 5, 'five day-and-feature rows in 30 days';
  SELECT * INTO r FROM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 30) s WHERE s.usage_date = today AND s.feature = 'copilot';
  ASSERT r.organization_input_tokens = 3300 AND r.organization_output_tokens = 350 AND r.organization_calls = 3, format('organization copilot: %s', r);
  ASSERT r.user_input_tokens = 2000 AND r.user_output_tokens = 100 AND r.user_calls = 1, format('C''s own copilot share: %s', r);
  SELECT * INTO r FROM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 30) s WHERE s.usage_date = today AND s.feature = 'drawing_reading';
  ASSERT r.organization_input_tokens = 4000 AND r.user_input_tokens = 0 AND r.user_calls = 0, format('C made no drawing reading: %s', r);
  SELECT * INTO r FROM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 30) s WHERE s.usage_date = today - 1;
  ASSERT r.feature = 'other' AND r.organization_input_tokens = 700 AND r.organization_calls = 3, format('yesterday, before the migration: %s', r);
  -- one day is today only; a longer window reaches the old row
  ASSERT (SELECT count(*) FROM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 1)) = 4, 'one day is today';
  ASSERT (SELECT count(*) FROM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 60)) = 6, '60 days reach the row of 40 days ago';
  BEGIN
    PERFORM public.ai_usage_summary('bbbbbbbb-0000-4000-8000-000000000002', 30);
    RAISE EXCEPTION 'C read B''s usage';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 0);
    RAISE EXCEPTION 'a window of no days was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_usage_summary('aaaaaaaa-0000-4000-8000-000000000001', 5000);
    RAISE EXCEPTION 'a window of 5000 days was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- the table itself still shows a member only their own rows
  ASSERT (SELECT count(*) FROM public.ai_usage_daily) = 2, 'C reads only its own two rows';
END $$;

-- B, in organization B, sees nothing of A.
SELECT set_config('test.uid', '11111111-0000-4000-8000-00000000000b', false);
SELECT set_config('test.org_ids', 'bbbbbbbb-0000-4000-8000-000000000002', false);
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.ai_usage_summary('bbbbbbbb-0000-4000-8000-000000000002', 30)) = 0, 'B has spent nothing';
END $$;
RESET ROLE;

SET ROLE anon;
DO $$
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.ai_usage_record(uuid, bigint, bigint, text)', 'EXECUTE'), 'anon cannot record';
  ASSERT NOT has_function_privilege('anon', 'public.ai_usage_summary(uuid, integer)', 'EXECUTE'), 'anon cannot read the summary';
END $$;
RESET ROLE;

DO $$
BEGIN
  ASSERT (SELECT count(*) = 4 AND bool_and(p.prosecdef AND p.proconfig::text LIKE '%search_path=public, pg_temp%') FROM pg_proc p
           WHERE p.proname IN ('ai_usage_today', 'ai_usage_record', 'ai_usage_summary')), 'the four definer functions pin search_path';
END $$;
