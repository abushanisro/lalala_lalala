-- ============================================================================
-- Migration 1163: the sheet-metal inspection check times from a published time study, each row with its source
-- ============================================================================
-- inspection_operation_defaults (migration 423) times each inspection check by feature and method. Its seed values were "disclosed
-- engineering estimates, not a claimed citation", and the visual method's (the method a part whose drawing states no tighter tolerance is
-- inspected by) are the ones the engine uses on most parts. The research of 2026-11-25 (user decisions of that day) times each check by the
-- BasicMOST "Measure" (M) card for the instrument the check implies (Zandin, MOST Work Measurement Systems; a secondary copy of the card,
-- slidetodoc.com "MOST - Maynard Operation Sequence Technique"; 1 TMU = 0.036 s; the measure step only, getting and putting aside the
-- instrument is not added):
--
--   hole, visual       1.2  -> 5.76 s   closest published basis: M16, plug gauge go/no-go to 1 in (160 TMU); no visual hole-check time was
--                                       found, so the hole is checked with a plug gauge
--   bend, visual       2.0  -> 3.60 s   M10, profile gauge (100 TMU); a protractor would be M16, 5.76 s
--   thickness, visual  3.0  -> 15.12 s  M42, micrometer < 4 in, outside diameter (420 TMU), the instrument the row names; a snap gauge would be
--                                       M6, 2.16 s
--   dimension, visual  5.0  -> 5.76 s   M16, calipers < 12 in (160 TMU); a steel tape would be M32, 11.52 s
--   thread, visual     3.0  -> 8.64 s   M24, thread gauge go/no-go internal/external to 1 in (240 TMU), the thread plug gauge the row names
--   visual_base        5.0     kept     no published source found: migration 423 took it from a pharmaceutical visual pass (Ph. Eur.
--                                       2.9.20); a BasicMOST "inspect" value was not found
--
-- The equipment of the hole, bend and dimension rows names the instrument timed. A new column, source, says where each row's time comes from;
-- the engine shows it in the trace of the Inspection line. The other methods' rows (caliper, height gauge, CMM) are 423's estimates and say so.
-- The engine's fallback for a missing row (FALLBACK_SEC, inspection-engine.ts) takes the same values.
-- Inspection lines of sheet-metal parts take longer: a part with a thickness and a dimension check gains 12.12 + 0.76 s.
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE public.inspection_operation_defaults ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN public.inspection_operation_defaults.source IS
  'Where cycle_time_sec comes from: the published time study (BasicMOST measure card, migration 1163) or that no published source was found.';

UPDATE public.inspection_operation_defaults SET cycle_time_sec = 5.76, equipment = 'Plug Gauge (go/no-go)',
  source = 'Closest published basis: BasicMOST measure M16, plug gauge go/no-go to 1 in, 160 TMU = 5.76 s (Zandin, MOST Work Measurement Systems; secondary copy of the card). No visual hole-check time was found, so the hole is checked with a plug gauge. Was 1.2 s, an estimate (migration 423).'
WHERE feature = 'hole' AND method = 'visual';

UPDATE public.inspection_operation_defaults SET cycle_time_sec = 3.60, equipment = 'Profile Gauge',
  source = 'BasicMOST measure M10, profile gauge, 100 TMU = 3.60 s (Zandin, MOST Work Measurement Systems; secondary copy of the card). A protractor would be M16, 5.76 s. Was 2.0 s, an estimate (migration 423).'
WHERE feature = 'bend' AND method = 'visual';

UPDATE public.inspection_operation_defaults SET cycle_time_sec = 15.12,
  source = 'BasicMOST measure M42, micrometer < 4 in, outside diameter, 420 TMU = 15.12 s (Zandin, MOST Work Measurement Systems; secondary copy of the card): the micrometer this row names. A snap gauge would be M6, 2.16 s. Was 3.0 s, an estimate (migration 423).'
WHERE feature = 'thickness' AND method = 'visual';

UPDATE public.inspection_operation_defaults SET cycle_time_sec = 5.76, equipment = 'Digital Caliper',
  source = 'BasicMOST measure M16, calipers < 12 in, 160 TMU = 5.76 s (Zandin, MOST Work Measurement Systems; secondary copy of the card). A steel tape would be M32, 11.52 s. Was 5.0 s, an estimate (migration 423).'
WHERE feature = 'dimension' AND method = 'visual';

UPDATE public.inspection_operation_defaults SET cycle_time_sec = 8.64,
  source = 'BasicMOST measure M24, thread gauge go/no-go internal/external to 1 in, 240 TMU = 8.64 s (Zandin, MOST Work Measurement Systems; secondary copy of the card): the thread plug gauge this row names. Was 3.0 s, an estimate (migration 423).'
WHERE feature = 'thread' AND method = 'visual';

UPDATE public.inspection_operation_defaults
SET source = 'No published source found (research of 2026-11-25): migration 423 took the 5 s from a visual pass of pharmaceutical quality control (Ph. Eur. 2.9.20), and no BasicMOST "inspect" value was found. Kept.'
WHERE feature = 'visual_base' AND method = 'visual';

UPDATE public.inspection_operation_defaults
SET source = 'Migration 423''s disclosed engineering estimate; no published time was checked for this method (the research of 2026-11-25 covered the visual method the engine uses unless the drawing escalates it).'
WHERE method <> 'visual' AND source IS NULL;

COMMIT;
