-- ============================================================================
-- Migration 1135: drop the Electronics module's tables, job queue and functions
-- ============================================================================
-- The Electronics module (migrations 909-916: designs, revisions, uploads, feature graphs, jobs, cost results, its reference
-- table; 920: the job queue its pipeline ran on) is removed: a PCB is an ordinary BOM item with Process = PCB, costed by
-- bom-items/costing/pcb and applied like every family (user decision 2026-11-23). No code reads or writes these tables any more.
--
-- The rows are deleted with the tables, permanently: the user chose to drop them now (2026-11-24) knowing they hold the
-- electronics designs, uploads and cost results made in the module. Nothing else references them (no foreign key from another
-- table; the job queue had no other producer).
--
-- The design files are in the object store (bucket electronics-uploads), which a migration cannot reach: run
-- scripts/purge-electronics-uploads.ts --yes once per environment to remove them. On a Supabase database the bucket's catalog row
-- is removed here when the storage schema allows it; when it refuses a direct delete, the row stays and a notice says so.
--
-- Idempotent: every DROP is IF EXISTS. Verify:
--   SELECT to_regclass('public.electronics_designs'), to_regclass('public.job_queue');   -- both NULL
-- ============================================================================

DROP TABLE IF EXISTS
  public.electronics_cost_results,
  public.electronics_feature_graphs,
  public.electronics_jobs,
  public.electronics_design_revisions,
  public.ecad_uploads,
  public.electronics_designs,
  public.electronics_reference_data,
  public.job_queue
  CASCADE;

DROP FUNCTION IF EXISTS public.enqueue_job(text, jsonb, integer);
DROP FUNCTION IF EXISTS public.claim_next_job(text, integer);
DROP FUNCTION IF EXISTS public.complete_job(uuid, jsonb);
DROP FUNCTION IF EXISTS public.fail_job(uuid, text);
DROP FUNCTION IF EXISTS public.prune_job_queue();
DROP FUNCTION IF EXISTS public.electronics_container_ok(uuid, uuid, uuid);

DO $electronics_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    BEGIN
      IF to_regclass('storage.objects') IS NOT NULL THEN
        DELETE FROM storage.objects WHERE bucket_id = 'electronics-uploads';
      END IF;
      DELETE FROM storage.buckets WHERE id = 'electronics-uploads';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'electronics-uploads bucket row left in place (%): empty it with scripts/purge-electronics-uploads.ts and remove it through the storage API', SQLERRM;
    END;
  END IF;
END $electronics_bucket$;

NOTIFY pgrst, 'reload schema';
