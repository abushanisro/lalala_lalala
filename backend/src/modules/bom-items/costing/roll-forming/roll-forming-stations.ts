// The roll stations a profile needs (memory/Sheet metal roll forming gives the lift per pass, rollFormingLiftAngle, but no formula; the rules
// are the engine's own, agreed with the user 2026-11-22). The cross-section's bends are grouped by precedence level, level k being k bends out
// from the web (the widest flat). A level is formed in passes of at most rollFormingLiftAngle, and of no more than a flange the bend carries can
// take between two stands: a flange of length a, bent dθ, deforms over L_d = sqrt(8 a³ dθ / (3 t)) along the strip (Bhattacharyya, Smith, Yee
// and Collins 1984, J Mech Work Technol 9:181-191, rigid-plastic), which must fit within the mill's stand spacing S, so a pass forms at most
// dθ_max = 3 t S² / (8 a³). The rigid-plastic length is conservative (later studies find the real deformation length shorter), so long flanges
// may be given a pass or two more than a mill needs. Then a lead-in pass above leadInRollStationThicknessThreshold and the cross-section
// tolerance's finishing passes. Bends close together form a group (the flat between consecutive bends within distanceBetweenGroupBendsMax x
// distanceBetweenGroupBendsMultiplier); a group whose turns cancel (a rib: its far flat returns to the plane, read from each bend's direction)
// is formed as one unit at the level of its inner bend, and carries only the span inside it, not the panel beyond. A profile of
// minNumBendsForPanelCrossSection bends or more is a panel: duplex mills and the panel tooling multiplier. The passes of each level are a calculator run per mill (Roll Forming - Level Passes); this file finds the levels and the flange
// each one carries. Pure.
import type { RollFormBend, RollFormPart } from './roll-forming-part';
import type { SandReference } from '../casting/sand/sand-reference';
import type { KitRow } from '../shared/calculators/route-kit';

/** A level of bends and the flange its bends carry (the passes come per mill, from the Level Passes calculator). */
export interface LevelPlan {
  level: number;
  bends: number;
  maxAngleDeg: number;
  /** The longest flange a bend of the level carries (mm): the strip from the bend out to the free edge (a closed section: the seam); null when not measured. */
  flangeCarriedMm: number | null;
}

export interface StationPlan {
  bendCount: number;
  levels: LevelPlan[];
  /** Where the levels come from: the cad-engine's own, the flats across the strip (from the widest), or assumed all on one level. */
  levelSource: 'cad' | 'flats' | 'assumed';
  /** How each bend's carried flange is found: across the open strip to its edge, round a closed section to the seam, half a tube's strip, or not known. */
  flangeSource: 'open strip' | 'closed section' | 'tube' | 'not measured';
  /** The groups of bends close together (two or more), each a rib when its turns cancel; directionsMeasured false when no bend has a direction. */
  groups: BendGroup[];
  directionsMeasured: boolean;
  groupGapMm: number | null;
  liftAngleDeg: number;
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
export const toleranceKey = (s: unknown): string => (typeof s === 'string' || typeof s === 'number' ? String(s) : '').replace(/\+\/-\s*/g, '+/-').replace(/\s+/g, ' ').trim().toLowerCase();

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

/** A bend's inner radius as priced: a bend modelled sharp takes the material's minimum bend radius (`sharpRadiusMm`). */
export const pricedRadius = (b: RollFormBend, sharpRadiusMm: number | null): number => (b.sharp ? sharpRadiusMm ?? 0 : b.innerRadiusMm ?? 0);

/**
 * The web of an open strip (the flat its bends are counted out from): the flat the bends' measured levels are counted from (k bends out from
 * it), the widest such flat when several fit; else, with no levels, the widest flat (the cad-engine's own rule).
 */
export function webIndex(bends: readonly RollFormBend[], flats: readonly number[]): number {
  const widest = (ws: readonly number[]) => ws.reduce((best, w) => (flats[w] > flats[best] ? w : best), ws[0]);
  if (bends.length && bends.every((b) => b.level != null)) {
    const fits = flats.map((_, w) => w).filter((w) => bends.every((b, i) => b.level === (i < w ? w - i : i - w + 1)));
    if (fits.length) return widest(fits);
  }
  return widest(flats.map((_, w) => w));
}

/** Bends close together (consecutive, the flat between each within the group gap): a rib when their signed turns cancel. */
export interface BendGroup {
  /** The first and last bend of the group (indices across the strip). */
  first: number;
  last: number;
  rib: boolean;
  /** The sum of the group's turns (degrees, each signed by its direction); null when a direction is not measured. */
  signedTurnDeg: number | null;
  /** A rib's level: its inner bend's (the lowest of its bends'); null for a group formed as flanges. */
  level: number | null;
  /** The span inside the group (its inner flats and the arcs between its first and last bend): what a rib carries. */
  spanMm: number | null;
}

/** A closed section with no flat (a round tube's two half turns, an oval ring of arcs): its bends each carry half the strip to the seam. */
export const isRing = (part: Pick<RollFormPart, 'bends' | 'section'>): boolean =>
  part.section.closed && part.bends.length > 0 && part.bends.every((b) => (b.flangeBeforeMm ?? 0) <= 1e-6);

type FlangePart = Pick<RollFormPart, 'bends' | 'lastFlangeMm' | 'thicknessMm' | 'section' | 'tube' | 'stripWidthMm'>;

/**
 * The flange each bend carries (mm): the strip from the bend out to the free edge on its outer side (the side away from the web), its flats
 * and the mid-line arcs of the bends beyond it. Round a closed section, the shorter way to the seam, taken opposite the web's middle. A
 * round or oval tube (two 180° bends) carries half its strip, the half circumference to the seam. Null for every bend when the flats were not
 * measured (a branched strip).
 */
export function flangesCarried(part: FlangePart, sharpRadiusMm: number | null): { carried: (number | null)[]; source: StationPlan['flangeSource'] } {
  const { bends } = part;
  if (isRing(part)) return { carried: bends.map(() => part.stripWidthMm / 2), source: 'tube' };
  const flats = [...bends.map((b) => b.flangeBeforeMm), part.section.closed ? 0 : part.lastFlangeMm];
  if (bends.length === 0 || flats.some((f) => f == null)) return { carried: bends.map(() => null), source: 'not measured' };
  const f = flats as number[];
  const arcs = bends.map((b) => ((b.angleDeg * Math.PI) / 180) * (pricedRadius(b, sharpRadiusMm) + part.thicknessMm / 2));
  const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
  if (part.section.closed) {
    // The ring from the web's start (the cad-engine lists a closed section from its web): flat 0, bend 0, flat 1, bend 1, ...
    const seam = f[0] / 2 + (sum(f) + sum(arcs)) / 2;
    let at = 0;
    const carried = bends.map((_, i) => {
      const start = at + f[i];
      const end = start + arcs[i];
      at = end;
      return Math.max(0, (start + end) / 2 <= seam ? seam - end : start - seam);
    });
    return { carried, source: 'closed section' };
  }
  const web = webIndex(bends, f);
  // Left of the web: the flats 0..i and the arcs of the bends before it, out to the strip's first edge; right of it, those after it.
  const carried = bends.map((_, i) => (i < web ? sum(f.slice(0, i + 1)) + sum(arcs.slice(0, i)) : sum(f.slice(i + 1)) + sum(arcs.slice(i + 1))));
  return { carried, source: 'open strip' };
}

/**
 * The groups of bends close together: consecutive bends whose flat between them is within `gapMm` (distanceBetweenGroupBendsMax x
 * distanceBetweenGroupBendsMultiplier). A group is a rib when every bend's direction is measured and their signed turns cancel (within a
 * degree): its far flat returns to the plane. A ring (a tube with no flat) has none.
 */
export function bendGroups(part: FlangePart, gapMm: number | null, levels: readonly number[], sharpRadiusMm: number | null): BendGroup[] {
  const { bends } = part;
  if (gapMm == null || isRing(part)) return [];
  const groups: BendGroup[] = [];
  let first = 0;
  const close = (i: number) => {
    if (i > first) {
      const members = bends.slice(first, i + 1);
      const measured = members.every((b) => b.direction != null);
      const signed = measured ? members.reduce((s, b) => s + b.direction! * b.angleDeg, 0) : null;
      const rib = signed != null && Math.abs(signed) <= 1;
      const inner = bends.slice(first + 1, i + 1).map((b) => b.flangeBeforeMm);
      const arcs = bends.slice(first + 1, i).map((b) => ((b.angleDeg * Math.PI) / 180) * (pricedRadius(b, sharpRadiusMm) + part.thicknessMm / 2));
      const span = inner.every((f) => f != null) ? (inner).reduce((s, x) => s + x, 0) + arcs.reduce((s, x) => s + x, 0) : null;
      groups.push({ first, last: i, rib, signedTurnDeg: signed, level: rib ? Math.min(...levels.slice(first, i + 1)) : null, spanMm: span });
    }
  };
  for (let i = 0; i < bends.length; i++) {
    const next = bends[i + 1]?.flangeBeforeMm;
    if (i + 1 < bends.length && next != null && next <= gapMm + 1e-9) continue;
    close(i);
    first = i + 1;
  }
  return groups;
}

/** The bends' levels, the flange each level carries (a rib its own span), the panel rule and the cross-section tolerance's row. */
export function stationPlan(ref: SandReference, part: FlangePart, sharpRadiusMm: number | null): StationPlan {
  const lift = ref.number('rollFormingLiftAngle') ?? 15;
  const { levels: measured, source } = bendLevels(part);
  const { carried: toEdge, source: flangeSource } = flangesCarried(part, sharpRadiusMm);
  const max = ref.number('distanceBetweenGroupBendsMax');
  const gapMm = max != null ? max * (ref.number('distanceBetweenGroupBendsMultiplier') ?? 1) : null;
  const groups = bendGroups(part, gapMm, measured, sharpRadiusMm);
  // A rib is formed as one unit at its inner bend's level, carrying only its own span.
  const byBend = [...measured];
  const carried = [...toEdge];
  for (const g of groups.filter((x) => x.rib)) {
    for (let i = g.first; i <= g.last; i++) {
      byBend[i] = g.level!;
      carried[i] = g.spanMm;
    }
  }
  const levels = new Map<number, { bends: number; maxAngleDeg: number; flangeCarriedMm: number | null }>();
  part.bends.forEach((b, i) => {
    const level = byBend[i];
    const l = levels.get(level) ?? { bends: 0, maxAngleDeg: 0, flangeCarriedMm: null };
    const a = carried[i] ?? null;
    levels.set(level, { bends: l.bends + 1, maxAngleDeg: Math.max(l.maxAngleDeg, b.angleDeg), flangeCarriedMm: a == null ? l.flangeCarriedMm : Math.max(l.flangeCarriedMm ?? 0, a) });
  });
  const panelThreshold = ref.number('minNumBendsForPanelCrossSection');
  const toleranceName = ref.text('crossSectionTolerance');
  return {
    bendCount: part.bends.length, levels: [...levels.entries()].sort(([a], [b]) => a - b).map(([level, l]) => ({ level, ...l })),
    levelSource: source, flangeSource, groups, directionsMeasured: part.bends.some((b) => b.direction != null), groupGapMm: gapMm, liftAngleDeg: lift,
    panel: panelThreshold != null && part.bends.length >= panelThreshold, panelThreshold,
    toleranceRow: toleranceRow(ref, 'Cross Section', toleranceName), toleranceName,
  };
}
