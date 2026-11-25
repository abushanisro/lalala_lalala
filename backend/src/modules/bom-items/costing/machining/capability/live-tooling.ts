/**
 * What a lathe makes only with a driven (live) tool, and whether a lathe has one.
 *
 * A lathe cuts on its spindle axis: a hole on the turning centreline is drilled with a stationary tool while the part turns. A radial
 * (cross) hole, an axial hole off the centreline, a milled keyway, a slot or a flat needs the tool to turn while the part is held still:
 * a live-tool spindle (C/Y axis). Each machine's live-tool spindle is its own data (mhr_records.live_tooling_power_kw, migration 1043, from
 * memory/Machining/machine): 0 kW means it has none. Pure: every fact comes in as data.
 */

/** An axial bore farther than this from the turning axis is not central: the CAD engine's own limit (MIN_DIST_MM in
 *  cad-engine/machining/machining_feature_recognizer.py, the bolt-circle detection). */
export const OFF_AXIS_MM = 3;

export interface LiveToolHole {
  diameterMm: number;
  count: number;
  /** cross: radial, across the turning axis; off_axis: parallel to it but off the centreline (a bolt circle, an offset tapped hole). */
  why: 'cross' | 'off_axis';
}

interface MachiningFeatureLike {
  type?: unknown;
  variant?: unknown;
  params?: Record<string, unknown> | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The part's holes that need a live tool, by diameter and reason (from the CAD engine's machining_features). */
export function liveToolHoles(features: readonly MachiningFeatureLike[] | null | undefined): LiveToolHole[] {
  const byKey = new Map<string, LiveToolHole>();
  const add = (diameterMm: number | null, count: number, why: LiveToolHole['why']) => {
    if (diameterMm == null || count <= 0) return;
    const key = `${why}|${diameterMm}`;
    const h = byKey.get(key) ?? { diameterMm, count: 0, why };
    h.count += count;
    byKey.set(key, h);
  };
  for (const f of features ?? []) {
    if (f.type !== 'SimpleHole') continue;
    const p = f.params ?? {};
    if (f.variant === 'cross') add(num(p.diameter_mm), 1, 'cross');
    // A hole pattern on a pitch circle is off the axis by definition (the CAD engine groups only bores beyond OFF_AXIS_MM, and cross holes).
    else if (f.variant === 'pcd_pattern') add(num(p.hole_diameter_mm), num(p.hole_count) ?? 0, 'off_axis');
    else if ((num(p.distance_from_axis_mm) ?? 0) > OFF_AXIS_MM) add(num(p.diameter_mm), 1, 'off_axis');
  }
  return [...byKey.values()].sort((a, b) => (a.why === b.why ? a.diameterMm - b.diameterMm : a.why === 'cross' ? -1 : 1));
}

/** The feature types a lathe mills, having no turning or drilling tool for them: a keyway that is not broached, a slot, and a flat. */
export const LATHE_MILLED_FEATURE_TYPES = ['Keyway', 'Slot', 'Flat'] as const;
export type LatheMilledFeatureType = (typeof LATHE_MILLED_FEATURE_TYPES)[number];

export const isLatheMilledFeatureType = (type: unknown): type is LatheMilledFeatureType =>
  (LATHE_MILLED_FEATURE_TYPES as readonly unknown[]).includes(type);

export interface LiveToolMilledFeature {
  type: LatheMilledFeatureType;
  count: number;
}

/** Everything on the part a lathe needs a live tool for. */
export interface LiveToolWork {
  holes: readonly LiveToolHole[];
  milled: readonly LiveToolMilledFeature[];
}

/**
 * The part's features a lathe mills, by type, from the features left to mill: feature_graph_v2 once the broached keyways and the wire-cut
 * slots are taken out of it (keyway-routing.ts, wire-edm-routing.ts). A feature counts once per occurrence, as the operation sequencer
 * mills it.
 */
export function liveToolMilledFeatures(features: readonly unknown[] | null | undefined): LiveToolMilledFeature[] {
  const counts = new Map<LatheMilledFeatureType, number>();
  for (const f of (features ?? []) as { feature_type?: unknown; occurrences?: unknown }[]) {
    const type = f.feature_type;
    if (!isLatheMilledFeatureType(type)) continue;
    const occurrences = Array.isArray(f.occurrences) ? f.occurrences.length : 0;
    counts.set(type, (counts.get(type) ?? 0) + (occurrences || 1));
  }
  return LATHE_MILLED_FEATURE_TYPES.flatMap((type) => {
    const count = counts.get(type);
    return count ? [{ type, count }] : [];
  });
}

const describeHoles = (holes: readonly LiveToolHole[]): string => {
  const total = (why: LiveToolHole['why']) => holes.filter((h) => h.why === why).reduce((s, h) => s + h.count, 0);
  const sizes = (why: LiveToolHole['why']) => holes.filter((h) => h.why === why).map((h) => `${h.count}x Ø${h.diameterMm}`).join(', ');
  return (['cross', 'off_axis'] as const)
    .filter((why) => total(why) > 0)
    .map((why) => `${total(why)} ${why === 'cross' ? 'cross' : 'off-axis'} hole${total(why) === 1 ? '' : 's'} (${sizes(why)})`)
    .join(' and ');
};

const describeMilled = (milled: readonly LiveToolMilledFeature[]): string =>
  milled.map((m) => `${m.count} ${m.type.toLowerCase()}${m.count === 1 ? '' : 's'}`).join(' and ');

/** What the live tool does on the part: "mill the part's 1 keyway and drill its 2 cross holes (2x Ø2.5)". */
const describe = (work: LiveToolWork): string => [
  work.milled.length > 0 ? `mill the part's ${describeMilled(work.milled)}` : null,
  work.holes.length > 0 ? `drill ${work.milled.length > 0 ? 'its' : 'the part\'s'} ${describeHoles(work.holes)}` : null,
].filter(Boolean).join(' and ');

/**
 * Whether the machine can make what the part needs a live tool for. A live-tool spindle of 0 kW rules it out; one not on file does not
 * (unknown is never assumed either way), and the route says so.
 */
export function liveToolingVerdict(
  work: LiveToolWork,
  capability: { liveToolingPowerKw: number | null } | null | undefined,
  machineName: string,
): { capable: boolean; warnings: string[] } {
  if (work.holes.length === 0 && work.milled.length === 0) return { capable: true, warnings: [] };
  const kw = capability?.liveToolingPowerKw ?? null;
  if (kw != null && kw > 0) return { capable: true, warnings: [] };
  if (kw === 0) {
    return {
      capable: false,
      warnings: [`${machineName} has no live-tool spindle (memory/Machining/machine): it cannot ${describe(work)}; a lathe with live tooling (C/Y axis) or a mill is needed.`],
    };
  }
  return {
    capable: true,
    warnings: [`Live tooling of ${machineName} is not on file: whether it can ${describe(work)} is not checked.`],
  };
}
