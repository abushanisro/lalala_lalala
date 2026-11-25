-- ============================================================================
-- Migration 1156: Concave Fillet Milling on the mills' operation catalog
-- ============================================================================
-- An inside (concave) fillet the CAD recognises (feature_graph_v2 Edge:round with concave=true, geo_v89) is now finished on the mill by a
-- ball nose end mill of its radius along its arc, a Concave Fillet Milling line timed by the Machining - Concave Fillet Milling calculator
-- migration 1155 adds and maps to the three mills (project owner decision of 2026-11-25). The operation catalog the engine confirms each
-- line's operation name against (process_taxonomy_operations, read by resolveMachiningOperationCategories) has no such operation: the
-- reference operation catalog (memory/machining/operations_full__operations.csv) gives an Edge only Rounding (a convex edge, which keeps its
-- Filleting line), so every Concave Fillet Milling line would carry the warning that its name is "not database-confirmed".
--
-- This adds "<mill>:Concave Fillet Milling//Edge" for each mill class whose process has an Edge Rounding row (3, 4 and 5 Axis Mill, the
-- classes migration 1155 maps the calculator to). A lathe forms a fillet at a turned shoulder by finish turning and mills no Edge feature,
-- so no lathe row is added.
--
-- Idempotent: a row is inserted only where its process has none of that string.
-- ============================================================================

INSERT INTO public.process_taxonomy_operations (canonical_process_id, operation_category, feature_type, raw_compound_string, notes)
SELECT DISTINCT pt.id, 'Concave Fillet Milling', 'Edge', pt.process_name || ':Concave Fillet Milling//Edge',
       'Migration 1156: an inside fillet finished by a ball nose end mill of its radius along its arc (project owner, 2026-11-25).'
FROM public.process_taxonomy pt
JOIN public.process_taxonomy_operations r ON r.canonical_process_id = pt.id AND r.operation_category = 'Rounding' AND r.feature_type = 'Edge'
WHERE pt.process_group = 'Machining'
  AND pt.machine_class IN ('3_axis_mill', '4_axis_mill', '5_axis_mill')
  AND NOT EXISTS (
    SELECT 1 FROM public.process_taxonomy_operations k
    WHERE k.canonical_process_id = pt.id AND k.raw_compound_string = pt.process_name || ':Concave Fillet Milling//Edge'
  );

-- Every mill that rounds an edge now finishes an inside fillet.
DO $check$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(DISTINCT pt.process_name, ', ') INTO missing
  FROM public.process_taxonomy pt
  JOIN public.process_taxonomy_operations r ON r.canonical_process_id = pt.id AND r.operation_category = 'Rounding' AND r.feature_type = 'Edge'
  WHERE pt.process_group = 'Machining'
    AND pt.machine_class IN ('3_axis_mill', '4_axis_mill', '5_axis_mill')
    AND NOT EXISTS (
      SELECT 1 FROM public.process_taxonomy_operations k
      WHERE k.canonical_process_id = pt.id AND k.operation_category = 'Concave Fillet Milling' AND k.feature_type = 'Edge'
    );
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Concave Fillet Milling catalog rows: no Concave Fillet Milling//Edge row for %', missing; END IF;
END
$check$;
