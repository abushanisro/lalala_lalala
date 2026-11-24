-- 1135: the Electronics module's tables, job queue and functions are gone, and dropping them twice is harmless.
DO $$
BEGIN
  ASSERT to_regclass('public.job_queue') IS NULL, 'job_queue is dropped';
  ASSERT to_regprocedure('public.enqueue_job(text, jsonb, integer)') IS NULL AND to_regprocedure('public.claim_next_job(text, integer)') IS NULL
     AND to_regprocedure('public.complete_job(uuid, jsonb)') IS NULL AND to_regprocedure('public.fail_job(uuid, text)') IS NULL
     AND to_regprocedure('public.prune_job_queue()') IS NULL, 'the job queue functions are dropped';
  ASSERT to_regprocedure('public.electronics_container_ok(uuid, uuid, uuid)') IS NULL, 'the design container check is dropped';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND (tablename LIKE 'electronics\_%' OR tablename = 'ecad_uploads')),
    'no electronics table is left';
END $$;
\i /migrations/1135_drop_electronics_module.sql
