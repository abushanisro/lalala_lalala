-- ============================================================================
-- Migration 1153: Knurling on the lathes' operation catalog
-- ============================================================================
-- A turned part's knurl callout (the drawing analyser reads them from parser v2) is now priced on the lathe as a Knurling line, timed by
-- the Machining - Knurling calculator migration 1138 added and mapped to the six lathe classes (process_calculator_mappings). The
-- operation catalog the engine confirms each line's operation name against (process_taxonomy_operations, read by
-- resolveMachiningOperationCategories) has a Thread Turning//Ring row for each of those lathes but no Knurling row: every Knurling line
-- carried the warning that its name is "not database-confirmed". The reference operation catalog (memory/machining/
-- operations_full__operations.csv) lists no knurling either; the project owner's decision of 2026-11-25 prices knurls on the lathes that
-- turn threads.
--
-- This adds "<lathe>:Knurling//Ring" for each lathe class that has "<lathe>:Thread Turning//Ring": 2 Axis Lathe, 3 Axis Lathe, the 2 and
-- 3 Axis Bar Feed Lathes with Sub Spindle, MillTurn and Simultaneous Turning (the classes migration 1138 maps the calculator to).
--
-- Idempotent: a row is inserted only where its process has none of that string.
-- ============================================================================

INSERT INTO public.process_taxonomy_operations (canonical_process_id, operation_category, feature_type, raw_compound_string, notes)
SELECT tt.canonical_process_id, 'Knurling', 'Ring', pt.process_name || ':Knurling//Ring',
       'Migration 1153: a knurl is rolled on a turned diameter, on the lathes that turn threads (project owner, 2026-11-25).'
FROM public.process_taxonomy_operations tt
JOIN public.process_taxonomy pt ON pt.id = tt.canonical_process_id
WHERE tt.operation_category = 'Thread Turning' AND tt.feature_type = 'Ring'
  AND pt.process_group = 'Machining'
  AND pt.machine_class IN ('2_axis_lathe', '3_axis_lathe', '2_axis_bar_feed_lathe_with_sub_spindle', '3_axis_bar_feed_lathe_with_sub_spindle',
                           'machining_millturn', 'simultaneous_turning')
  AND NOT EXISTS (
    SELECT 1 FROM public.process_taxonomy_operations k
    WHERE k.canonical_process_id = tt.canonical_process_id AND k.raw_compound_string = pt.process_name || ':Knurling//Ring'
  );

-- Every lathe that turns threads now knurls.
DO $check$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(pt.process_name, ', ') INTO missing
  FROM public.process_taxonomy_operations tt
  JOIN public.process_taxonomy pt ON pt.id = tt.canonical_process_id
  WHERE tt.operation_category = 'Thread Turning' AND tt.feature_type = 'Ring' AND pt.process_group = 'Machining'
    AND pt.machine_class IN ('2_axis_lathe', '3_axis_lathe', '2_axis_bar_feed_lathe_with_sub_spindle', '3_axis_bar_feed_lathe_with_sub_spindle',
                             'machining_millturn', 'simultaneous_turning')
    AND NOT EXISTS (
      SELECT 1 FROM public.process_taxonomy_operations k
      WHERE k.canonical_process_id = tt.canonical_process_id AND k.operation_category = 'Knurling' AND k.feature_type = 'Ring'
    );
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Knurling catalog rows: no Knurling//Ring row for %', missing; END IF;
END
$check$;
