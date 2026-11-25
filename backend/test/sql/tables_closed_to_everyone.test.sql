-- 1122: a table with row-level security and no policy is closed to everyone. The two that are used with a signed-in user's token get
-- policies that follow their parent rows. (That the service-only tables are closed explicitly is checked on the whole stack, after
-- every migration, by test/local-data/run.sh.)
-- Alice owns subtask S1 and can see BOM item A. Bob owns subtask S2 and can see BOM item B.
INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
INSERT INTO public.bom_items (id, organization_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '0a000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '0b000000-0000-4000-8000-000000000002');
-- the BOM items' own tenancy rule, as the real table has one: the policies under test must inherit it, not restate it
ALTER TABLE public.bom_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_select_bom_items ON public.bom_items FOR SELECT USING (organization_id IN (SELECT public.current_user_org_ids()));
GRANT SELECT ON public.bom_items TO authenticated;
INSERT INTO public.process_subtasks (id, user_id) VALUES
  ('51000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111'),
  ('52000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222');

-- ── Alice ────────────────────────────────────────────────────────────────────
SET ROLE authenticated;
SET test.uid = '11111111-1111-4111-8111-111111111111';
SET test.org_ids = '0a000000-0000-4000-8000-000000000001';
DO $$
DECLARE n int;
BEGIN
  INSERT INTO public.subtask_bom_requirements (subtask_id, bom_item_id, required_quantity, unit, created_by)
  VALUES ('51000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4, 'pcs', '11111111-1111-4111-8111-111111111111');
  SELECT count(*) INTO n FROM public.subtask_bom_requirements;
  ASSERT n = 1, 'the owner of a subtask saves what it needs and reads it back (it was refused, and read back empty)';
  UPDATE public.subtask_bom_requirements SET required_quantity = 6 WHERE subtask_id = '51000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'and changes it';

  BEGIN
    INSERT INTO public.subtask_bom_requirements (subtask_id, bom_item_id, required_quantity, created_by)
    VALUES ('52000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, '11111111-1111-4111-8111-111111111111');
    ASSERT false, 'a requirement cannot be added to somebody else''s subtask';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.subtask_bom_requirements (subtask_id, bom_item_id, required_quantity, created_by)
    VALUES ('51000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, '11111111-1111-4111-8111-111111111111');
    ASSERT false, 'a requirement cannot name a BOM item the user cannot see';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.subtask_bom_requirements (subtask_id, bom_item_id, required_quantity, created_by)
    VALUES ('51000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, '22222222-2222-4222-8222-222222222222');
    ASSERT false, 'a requirement cannot be created in another user''s name';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  INSERT INTO public.cad_analysis_history (bom_item_id, user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111');
  SELECT count(*) INTO n FROM public.cad_analysis_history;
  ASSERT n = 1, 'an analysis of an item the user can see is recorded and read back (the insert was refused, so the history stayed empty)';
  BEGIN
    INSERT INTO public.cad_analysis_history (bom_item_id, user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222');
    ASSERT false, 'a history row cannot be recorded in another user''s name';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.cad_analysis_history (bom_item_id, user_id) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111');
    ASSERT false, 'nor for an item the user cannot see';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.cad_analysis_history SET created_at = now();
    ASSERT false, 'the history is an audit trail: a user does not edit it';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.cad_analysis_history;
    ASSERT false, 'nor delete from it';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- ── Bob ──────────────────────────────────────────────────────────────────────
SET test.uid = '22222222-2222-4222-8222-222222222222';
SET test.org_ids = '0b000000-0000-4000-8000-000000000002';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.subtask_bom_requirements;
  ASSERT n = 0, 'another user does not see the requirements of a subtask that is not theirs';
  UPDATE public.subtask_bom_requirements SET required_quantity = 99;
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'nor change them';
  DELETE FROM public.subtask_bom_requirements;
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'nor remove them';
  SELECT count(*) INTO n FROM public.cad_analysis_history;
  ASSERT n = 0, 'nor the analysis history of an item they cannot see';
END $$;
RESET ROLE;

-- ── Nobody else, and the rule itself ─────────────────────────────────────────
DO $$
DECLARE closed text;
BEGIN
  ASSERT (SELECT required_quantity FROM public.subtask_bom_requirements) = 6, 'Alice''s requirement is as she left it';
  ASSERT NOT has_table_privilege('anon', 'public.subtask_bom_requirements', 'SELECT') AND NOT has_table_privilege('anon', 'public.cad_analysis_history', 'SELECT'),
    'anonymous callers read neither table';

  -- The rule test/local-data/run.sh checks after every migration: a table a signed-in user is granted has a policy.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO closed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    AND (has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE') OR has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE'));
  ASSERT closed IS NULL, 'granted to signed-in users, with row-level security and no policy: ' || closed;
END $$;
