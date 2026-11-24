-- ============================================================================
-- Migration 1131: a BOM item keeps its board set (Gerber layers, drill file, Pick Place)
-- ============================================================================
-- A printed circuit board is an ordinary BOM item whose Process is PCB (the PCB plan, user decision 2026-11-23). Its board files are what the
-- CAD engine measures it from (cad-engine pcb/: outline, copper layers, holes, solder mask and legend sides, nets, placements), so the item
-- keeps them: one zip (a .zip as uploaded, or the loose files packed into one), beside its 3D model, drawing and DXF.
--
-- file_paths_in_use (migration 918) finds every bom_items file_*_path column by name, so a stored board set counts as in use without a change.
--
-- Idempotent. Verify: SELECT column_name FROM information_schema.columns WHERE table_name = 'bom_items' AND column_name = 'file_board_path';
-- ============================================================================

ALTER TABLE public.bom_items ADD COLUMN IF NOT EXISTS file_board_path text;

COMMENT ON COLUMN public.bom_items.file_board_path IS 'The board set (Gerber layers, drill file and report, Pick Place, BOM table) as one zip in the bom-files bucket; measured into feature_graph.summary.pcbGeometry when the part is analysed.';

NOTIFY pgrst, 'reload schema';
