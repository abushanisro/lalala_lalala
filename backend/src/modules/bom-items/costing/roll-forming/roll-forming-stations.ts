// The roll stations a profile needs (memory/Sheet metal roll forming; the rule is the engine's own, agreed with the user 2026-11-22, as the data
// gives the lift per pass but no formula): the cross-section's bends grouped by precedence level, level k being k bends out from the web (the
// widest flat), each level taking ceil(its largest angle / rollFormingLiftAngle) passes, then a lead-in pass above
// leadInRollStationThicknessThreshold and the finishing passes of the cross-section tolerance (the Stations calculator adds those). A profile
// of minNumBendsForPanelCrossSection bends or more is a panel: duplex mills and the panel tooling multiplier. Pure.
import type { RollFormPart } from './roll-forming-part';
import type { SandReference } from '../casting/sand/sand-reference';
import type { KitRow } from '../shared/calculators/route-kit';

export interface StationLevel {
  level: number;
  bends: number;
  maxAngleDeg: number;
  passes: number;
}

export interface StationPlan {
  bendCount: number;
  levels: StationLevel[];
  /** Where the levels come from: the cad-engine's own, the flats across the strip (from the widest), or assumed all on one level. */
  levelSource: 'cad' | 'flats' | 'assumed';
  liftAngleDeg: number;
  /** The passes the bends take: the sum over the levels. */
  formingPasses: number;
  panel: boolean;
  panelThreshold: number | null;
  /** The cross-section tolerance's toleranceThresholds row (Number of Finishing Passes, Line Speed Multiplier), null when none matches. */
  toleranceRow: KitRow | null;
  toleranceName: string | null;
}

/**
 * A tolerance name as the data's tables can be matched by: the variables write "+/- 0.762mm" where a table row writes "+/-0.762mm"
 * (partLengthTolerance and its partLengthToleranceThresholds row), so the space after "+/-" and repeated spaces are not significant.
 */
export const toleranceKey = (s: unknown): string => String(s ?? '').replace(/\+\/-\s*/g, '+/-').replace(/\s+/g, ' ').trim().toLowerCase();

/** The toleranceThresholds row of a tolerance type and name (the variable's value), or null. */
export function toleranceRow(ref: SandReference, type: string, name: string | null): KitRow | null {
  if (!name) return null;
  return ref.table('toleranceThresholds').find((r) => toleranceKey(r['Tolerance Type']) === toleranceKey(type) && toleranceKey(r['Tolerance Name']) === toleranceKey(name)) ?? null;
}

/** The level of each bend: the cad-engine's own; else from the flats across the strip, k bends out from the widest; else all on level 1. */
export function bendLevels(part: Pick<RollFormPart, 'bends' | 'lastFlangeMm'>): { levels: number[]; source: StationPlan['levelSource'] } {
  const bends = part.bends;
  if (bends.every((b) => b.level != null)) return { levels: bends.map((b) => b.level!), source: 'cad' };
  const flats = [...bends.map((b) => b.flangeBeforeMm), part.lastFlangeMm];
  if (bends.length > 0 && flats.every((f) => f != null)) {
    const widths = flats;
    const web = widths.indexOf(Math.max(...widths));
    // Bend i lies between flat i and flat i + 1: on the web's left it is web - i bends out, on its right i - web + 1.
    return { levels: bends.map((_, i) => (i < web ? web - i : i - web + 1)), source: 'flats' };
  }
  return { levels: bends.map((b) => b.level ?? 1), source: 'assumed' };
}

/** The bends' levels and passes (before the lead-in and finishing passes), the panel rule and the cross-section tolerance's row. */
export function stationPlan(ref: SandReference, part: Pick<RollFormPart, 'bends' | 'lastFlangeMm'>): StationPlan {
  const lift = ref.number('rollFormingLiftAngle') ?? 15;
  const { levels: byBend, source } = bendLevels(part);
  const levels = new Map<number, { bends: number; maxAngleDeg: number }>();
  part.bends.forEach((b, i) => {
    const level = byBend[i];
    const l = levels.get(level) ?? { bends: 0, maxAngleDeg: 0 };
    levels.set(level, { bends: l.bends + 1, maxAngleDeg: Math.max(l.maxAngleDeg, b.angleDeg) });
  });
  const rows = [...levels.entries()].sort(([a], [b]) => a - b)
    .map(([level, l]) => ({ level, bends: l.bends, maxAngleDeg: l.maxAngleDeg, passes: Math.ceil(l.maxAngleDeg / lift - 1e-9) }));
  const panelThreshold = ref.number('minNumBendsForPanelCrossSection');
  const toleranceName = ref.text('crossSectionTolerance');
  return {
    bendCount: part.bends.length, levels: rows, levelSource: source, liftAngleDeg: lift,
    formingPasses: rows.reduce((s, r) => s + r.passes, 0),
    panel: panelThreshold != null && part.bends.length >= panelThreshold, panelThreshold,
    toleranceRow: toleranceRow(ref, 'Cross Section', toleranceName), toleranceName,
  };
}
