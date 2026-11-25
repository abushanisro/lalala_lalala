/**
 * Which countersinks sit on a hole the CAD recognised. A countersink is the cone at a hole's mouth: when the hole under it is a feature of
 * its own (a SimpleHole or MultiStepHole), that feature is drilled, so the countersink adds only the countersinking. Drilling it again
 * (the old rule drilled every countersink at 0.6 x its diameter) costed the hole twice: the Motor Mount's Ø12.5 over its stepped hole, the
 * Cannula's Ø3.7 x2 over its Ø3.2 M4 holes, the Carriage Mount's Ø4.0 x4 over its Ø2.2 holes.
 *
 * Coaxial: the countersink's centre lies on the hole's axis (the line through the hole's centre along its tool axis), within ON_AXIS_MM.
 * Centres are the feature graph's (feature_graph_v2 occurrence centroids, the same frame for every feature of a part).
 */

/** How far off a hole's axis a countersink's centre may lie and still be that hole's (mm): centroids are rounded to 0.05 mm. */
export const ON_AXIS_MM = 0.1;

type Vec = readonly [number, number, number];
interface Occurrence { centroid?: unknown; tool_axis?: unknown; steps?: unknown }
interface Feature { feature_type?: unknown; diameter_mm?: unknown; occurrences?: unknown }

const vec = (v: unknown): Vec | null =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as unknown as Vec) : null;

/** A recognised hole: its centre, its axis where the CAD states one, and its diameter at the mouth where the CAD gives one. */
export interface HoleAxis { centre: Vec; axis: Vec | null; diameterMm: number | null }

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The hole occurrences of the part (SimpleHole and MultiStepHole). The diameter is a SimpleHole's own, a MultiStepHole's first step's (its
 * entry, as the spotting takes it).
 */
export function holeAxes(features: readonly Feature[]): HoleAxis[] {
  return features
    .filter((f) => f.feature_type === 'SimpleHole' || f.feature_type === 'MultiStepHole')
    .flatMap((f) =>
      (Array.isArray(f.occurrences) ? (f.occurrences as Occurrence[]) : []).flatMap((o) => {
        const centre = vec(o.centroid);
        if (!centre) return [];
        const entry = Array.isArray(o.steps) ? (o.steps[0] as { diameter_mm?: unknown } | undefined)?.diameter_mm : undefined;
        const diameterMm = f.feature_type === 'MultiStepHole' ? positive(entry) : positive(f.diameter_mm);
        return [{ centre, axis: vec(o.tool_axis), diameterMm }];
      }),
    );
}

/**
 * The countersink's centre lies on one of the holes' axes. A hole with no stated axis is taken along the direction the two centres differ
 * in most (holes are drilled along a part axis), so the other two coordinates must agree.
 */
export function sitsOnHole(countersink: Occurrence, holes: readonly HoleAxis[]): boolean {
  return holeUnder(countersink, holes) !== null;
}

/** The recognised hole the countersink sits on (see sitsOnHole), or null. */
export function holeUnder(countersink: Occurrence, holes: readonly HoleAxis[]): HoleAxis | null {
  const c = vec(countersink.centroid);
  if (!c) return null;
  return holes.find(({ centre, axis }) => {
    const d: Vec = [c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]];
    if (axis) {
      const n = Math.hypot(...axis);
      if (n === 0) return false;
      const a: Vec = [axis[0] / n, axis[1] / n, axis[2] / n];
      const along = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
      return Math.hypot(d[0] - along * a[0], d[1] - along * a[1], d[2] - along * a[2]) <= ON_AXIS_MM;
    }
    const sorted = d.map(Math.abs).sort((x, y) => x - y);
    return sorted[0]! <= ON_AXIS_MM && sorted[1]! <= ON_AXIS_MM;
  }) ?? null;
}
