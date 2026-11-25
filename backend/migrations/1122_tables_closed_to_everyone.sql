-- ============================================================================
-- Migration 1122: no table is open to signed-in users and closed to everyone at once
-- ============================================================================
-- A table with row-level security switched on and NO policy answers every signed-in read with nothing and refuses every write, without
-- an error a person would see. Migration 1121 fixed one (the consumable prices: a waterjet's garnet was never costed). Two more are
-- used with the signed-in user's own token:
--
--   subtask_bom_requirements   Production planning saves the BOM items a subtask needs. The insert was refused, the service logged a
--                              warning and went on, so a subtask never kept its requirements and always read back with none.
--   cad_analysis_history       update_bom_item_cad_analysis() (which runs as the caller) records each analysis here. Its insert was
--                              refused, so the whole call failed, the backend fell back to a plain update, and the history stayed empty.
--
-- Each gets the policies its parent rows imply, stated through the parent so the tenancy rule lives in one place:
--   a requirement belongs to its subtask: whoever may work on the subtask (process_subtasks' own policies) may read and change it. A
--   new one must also name a BOM item the user can see, and its creator is the user.
--   an analysis history row belongs to its BOM item: whoever can see the item reads it. A user adds rows under their own name only,
--   and never edits or deletes one (it is an audit trail; prune_old_rows() trims it).
--
-- A table is either given its policies or, when only the service role uses it, says so by having its grants to signed-in users
-- revoked (as migrations 901, 920, 943 and 1004 do). Row-level security with no policy on a table that is still granted is the state
-- that cannot be told from a forgotten policy, and test/local-data/run.sh now fails on it after every migration. Two service-only
-- tables that the tracked code creates were in it and are closed explicitly here: user_session_activity (migration 901 revoked its
-- grants; a database loaded from the baseline got them back from the default privileges) and schema_migrations (the runner's own).
--
-- The older tables in the same state (the enhanced material tables, the backup copies, costing_settings, mhr_benchmark_rates,
-- sm_lookup_router_cut, cad_analysis_cache) are read by the service role or by nothing, and their grants are deliberately left alone:
-- a trigger that runs as the caller (trg_update_cache_access on bom_items) updates cad_analysis_cache on every saved analysis, and
-- revoking that grant would turn its harmless no-op into "permission denied" on the save. Closing those needs each one looked at.
-- Idempotent.
-- ============================================================================

-- ── 1. subtask_bom_requirements ─────────────────────────────────────────────
ALTER TABLE public.subtask_bom_requirements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_subtask_bom_requirements ON public.subtask_bom_requirements;
DROP POLICY IF EXISTS add_subtask_bom_requirements ON public.subtask_bom_requirements;
DROP POLICY IF EXISTS change_subtask_bom_requirements ON public.subtask_bom_requirements;
DROP POLICY IF EXISTS remove_subtask_bom_requirements ON public.subtask_bom_requirements;

CREATE POLICY read_subtask_bom_requirements ON public.subtask_bom_requirements FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.process_subtasks s WHERE s.id = subtask_bom_requirements.subtask_id));
CREATE POLICY add_subtask_bom_requirements ON public.subtask_bom_requirements FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.process_subtasks s WHERE s.id = subtask_bom_requirements.subtask_id)
    AND EXISTS (SELECT 1 FROM public.bom_items b WHERE b.id = subtask_bom_requirements.bom_item_id)
  );
CREATE POLICY change_subtask_bom_requirements ON public.subtask_bom_requirements FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.process_subtasks s WHERE s.id = subtask_bom_requirements.subtask_id))
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.process_subtasks s WHERE s.id = subtask_bom_requirements.subtask_id)
    AND EXISTS (SELECT 1 FROM public.bom_items b WHERE b.id = subtask_bom_requirements.bom_item_id)
  );
CREATE POLICY remove_subtask_bom_requirements ON public.subtask_bom_requirements FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.process_subtasks s WHERE s.id = subtask_bom_requirements.subtask_id));

REVOKE ALL ON public.subtask_bom_requirements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subtask_bom_requirements TO authenticated;

-- ── 2. cad_analysis_history ─────────────────────────────────────────────────
ALTER TABLE public.cad_analysis_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_cad_analysis_history ON public.cad_analysis_history;
DROP POLICY IF EXISTS record_cad_analysis_history ON public.cad_analysis_history;

CREATE POLICY read_cad_analysis_history ON public.cad_analysis_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.bom_items b WHERE b.id = cad_analysis_history.bom_item_id));
CREATE POLICY record_cad_analysis_history ON public.cad_analysis_history FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.bom_items b WHERE b.id = cad_analysis_history.bom_item_id)
  );

REVOKE ALL ON public.cad_analysis_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.cad_analysis_history TO authenticated;

-- ── 3. The service-only tables the tracked code creates say that they are ────
DO $service_only$
DECLARE
  t text;
BEGIN
  -- schema_migrations exists only where the runner has run (not where a migration is applied by hand)
  FOREACH t IN ARRAY ARRAY['user_session_activity', 'schema_migrations'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    END IF;
  END LOOP;
END
$service_only$;
