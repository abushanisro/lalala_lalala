-- ============================================================================
-- Migration 1115: Stock Machining's two catalog mappings get their machine classes
-- ============================================================================
-- process_calculator_mappings holds Stock Machining > Band Saw and Stock Machining > Material Stock (migration 790) with no machine class
-- and inactive. A mapping becomes active when a calculator is linked to it and it has a machine class to run on: migration 1116 links the
-- Stock Machining calculators, so the two rows first get the classes their processes have in process_taxonomy (migration 1114): the band
-- saws of migration 815 (band_saw) and the Material Stock machine of migration 1114 (stock_machining_material_stock).
--
-- Idempotent. Verify:
--   SELECT operation, machine_class, is_active, calculator_name FROM process_calculator_mappings WHERE process_group = 'Stock Machining';
-- ============================================================================

UPDATE public.process_calculator_mappings m
SET machine_class = v.machine_class, updated_at = now()
FROM (VALUES ('Band Saw', 'band_saw'), ('Material Stock', 'stock_machining_material_stock')) AS v(operation, machine_class)
WHERE m.process_group = 'Stock Machining' AND m.process_route = v.operation AND m.operation = v.operation
  AND m.machine_class IS DISTINCT FROM v.machine_class;

NOTIFY pgrst, 'reload schema';
