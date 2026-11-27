-- ============================================================================
-- Migration 1166: AI token usage per feature, and a summary the app can show
-- ============================================================================
-- Before: ai_usage_daily (949) counted tokens per UTC day, user and organization. Nothing said which feature spent them, and a
-- member reads only their own rows, so the app had no real figures to show: its "EMITHRAN AI" bar showed credits worked out from
-- project counts.
--
-- Now:
--   * ai_usage_daily.feature: the feature the tokens were spent in ('copilot', 'drawing_reading', 'vave'; 'other' for rows
--     written before this migration and for a feature the backend does not name). It joins the primary key, so one row is one
--     UTC day, user, organization and feature. ai_usage_today() sums the day's rows as before: the budgets do not change.
--   * ai_usage_record(org, input, output, feature): adds one call's usage to the caller's row for that feature. The
--     three-argument form (949) stays, for a backend one release behind, and counts under 'other'.
--   * ai_usage_summary(org, days): for each of the last `days` UTC days and each feature, the organization's tokens and calls and
--     the caller's own share of them. Like ai_usage_today() it acts for auth.uid() only, refuses an organization the caller is
--     not an active member of (42501), and is SECURITY DEFINER because the organization's figures sum other members' rows. It
--     returns totals only, never another member's own usage.
-- Apply before the backend that calls the four-argument ai_usage_record().
-- Idempotent.
-- ============================================================================

ALTER TABLE public.ai_usage_daily ADD COLUMN IF NOT EXISTS feature text NOT NULL DEFAULT 'other';
COMMENT ON COLUMN public.ai_usage_daily.feature IS
  'The feature the tokens were spent in (AiBudgetService names it); ''other'' for rows from before migration 1166.';

DO $$
DECLARE
  v_key text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_usage_daily'::regclass AND conname = 'ai_usage_daily_feature_format') THEN
    ALTER TABLE public.ai_usage_daily ADD CONSTRAINT ai_usage_daily_feature_format CHECK (feature ~ '^[a-z][a-z_]{0,39}$');
  END IF;
  -- The primary key of 949 (usage_date, user_id, organization_id) gains the feature.
  SELECT conname INTO v_key FROM pg_constraint
   WHERE conrelid = 'public.ai_usage_daily'::regclass AND contype = 'p' AND array_length(conkey, 1) = 3;
  IF v_key IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.ai_usage_daily DROP CONSTRAINT %I', v_key);
    ALTER TABLE public.ai_usage_daily ADD CONSTRAINT ai_usage_daily_pkey PRIMARY KEY (usage_date, user_id, organization_id, feature);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ai_usage_record(p_organization_id uuid, p_input_tokens bigint, p_output_tokens bigint, p_feature text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL OR p_organization_id NOT IN (SELECT public.current_user_org_ids()) THEN
    RAISE EXCEPTION 'not a member of organization %', p_organization_id USING ERRCODE = '42501';
  END IF;
  IF p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_input_tokens < 0 OR p_output_tokens < 0 THEN
    RAISE EXCEPTION 'token counts must be non-negative' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z][a-z_]{0,39}$' THEN
    RAISE EXCEPTION 'feature must be a short lower-case name' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_usage_daily AS u (usage_date, user_id, organization_id, feature, input_tokens, output_tokens, calls)
  VALUES ((now() AT TIME ZONE 'utc')::date, v_uid, p_organization_id, p_feature, p_input_tokens, p_output_tokens, 1)
  ON CONFLICT (usage_date, user_id, organization_id, feature) DO UPDATE
    SET input_tokens  = u.input_tokens + excluded.input_tokens,
        output_tokens = u.output_tokens + excluded.output_tokens,
        calls         = u.calls + 1,
        updated_at    = now();
END
$fn$;

-- The form a backend from before this migration calls: the same checks and the same row, under 'other'.
CREATE OR REPLACE FUNCTION public.ai_usage_record(p_organization_id uuid, p_input_tokens bigint, p_output_tokens bigint)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  PERFORM public.ai_usage_record(p_organization_id, p_input_tokens, p_output_tokens, 'other');
END
$fn$;

CREATE OR REPLACE FUNCTION public.ai_usage_summary(p_organization_id uuid, p_days integer)
RETURNS TABLE (
  usage_date date, feature text,
  organization_input_tokens bigint, organization_output_tokens bigint, organization_calls bigint,
  user_input_tokens bigint, user_output_tokens bigint, user_calls bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_day date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL OR p_organization_id NOT IN (SELECT public.current_user_org_ids()) THEN
    RAISE EXCEPTION 'not a member of organization %', p_organization_id USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN
    RAISE EXCEPTION 'days must be between 1 and 366' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT u.usage_date, u.feature,
           sum(u.input_tokens)::bigint, sum(u.output_tokens)::bigint, sum(u.calls)::bigint,
           coalesce(sum(u.input_tokens) FILTER (WHERE u.user_id = v_uid), 0)::bigint,
           coalesce(sum(u.output_tokens) FILTER (WHERE u.user_id = v_uid), 0)::bigint,
           coalesce(sum(u.calls) FILTER (WHERE u.user_id = v_uid), 0)::bigint
      FROM public.ai_usage_daily u
     WHERE u.organization_id = p_organization_id AND u.usage_date > v_day - p_days AND u.usage_date <= v_day
     GROUP BY u.usage_date, u.feature
     ORDER BY 1, 2;
END
$fn$;

REVOKE ALL ON FUNCTION public.ai_usage_record(uuid, bigint, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_usage_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_usage_record(uuid, bigint, bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_usage_summary(uuid, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
