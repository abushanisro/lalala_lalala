// How raw stock is sized from a part, as memory's stock rules state it (memory/Stock Maching and memory/Multi-Spindle Maching share them):
// an allowance on each side that is a percent of the part's outside size between a least and a most, the size snapped up to the next
// preferred size of the location's unit system, and the width a parting tool takes. Pure; each engine reads its own variables into these.
import type { SandReference } from '../casting/sand/sand-reference';

export type UnitSystem = 'US' | 'metric';

export interface PreferredSize {
  sizeMm: number;
  /** The table's own name for the size: 5/8", 16 mm. */
  label: string;
}

/** The allowance on each side of a stock form: a percent of the part's outside size, at least `minMm` and at most `maxMm`. */
export interface AllowanceRule {
  percent: number;
  minMm: number;
  maxMm: number;
}

/** Inch stock in USA, metric stock everywhere else (user decision 2026-11-20: stock sizes by location). */
export function unitSystemFor(location: string): UnitSystem {
  return location === 'USA' ? 'US' : 'metric';
}

/** The allowance on each side for a part of this outside size (its OD, across flats, or larger section side). */
export function allowancePerSideMm(rule: AllowanceRule, outsideMm: number): number {
  return Math.min(rule.maxMm, Math.max(rule.minMm, (rule.percent / 100) * outsideMm));
}

/**
 * A unit system's own preferred sizes from the staged tblPreferredSizes (rows of sizeMm, unitSystem, comment; "both" is the two systems
 * together, a third series): ascending, one entry per size.
 */
export function preferredSizesOf(ref: SandReference, system: UnitSystem): PreferredSize[] {
  const rows = ref.table('tblPreferredSizes')
    .filter((r) => r.unitSystem === system && Number(r.sizeMm) > 0)
    .map((r) => ({ sizeMm: Number(r.sizeMm), label: String(r.comment ?? `${Number(r.sizeMm)} mm`).trim() }))
    .sort((a, b) => a.sizeMm - b.sizeMm);
  return rows.filter((s, i) => i === 0 || s.sizeMm !== rows[i - 1].sizeMm);
}

/** The first preferred size at or above what is needed; null when the series has none that large. */
export function snapUp(sizes: readonly PreferredSize[], requiredMm: number): PreferredSize | null {
  return sizes.find((s) => s.sizeMm >= requiredMm - 1e-9) ?? null;
}

/** The parting rings of the staged tblPartingRingWidth (rows of diameterMm, ringWidthMm), ascending by diameter. */
export function partingRingsOf(ref: SandReference): { diameterMm: number; ringWidthMm: number }[] {
  return ref.table('tblPartingRingWidth')
    .map((r) => ({ diameterMm: Number(r.diameterMm), ringWidthMm: Number(r.ringWidthMm) }))
    .filter((r) => r.diameterMm > 0 && r.ringWidthMm > 0)
    .sort((a, b) => a.diameterMm - b.diameterMm);
}

/** The width a parting tool takes through stock of this diameter: the first row that covers it, the last for larger stock; null with no rows. */
export function partingWidthMm(rings: readonly { diameterMm: number; ringWidthMm: number }[], diameterMm: number): number | null {
  return (rings.find((r) => r.diameterMm >= diameterMm - 1e-9) ?? rings.at(-1))?.ringWidthMm ?? null;
}

/** A bar's cross-section: round π/4 D², hex √3/2 AF², square AF². */
export function barSectionAreaMm2(form: 'round' | 'hex' | 'square', sizeMm: number): number {
  if (form === 'hex') return (Math.sqrt(3) / 2) * sizeMm ** 2;
  if (form === 'square') return sizeMm ** 2;
  return (Math.PI / 4) * sizeMm ** 2;
}

/** The diameter of the circle through a bar's corners: round D, hex 2 AF / √3, square √2 AF. */
export function circumscribedDiameterMm(form: 'round' | 'hex' | 'square', sizeMm: number): number {
  if (form === 'hex') return (2 * sizeMm) / Math.sqrt(3);
  if (form === 'square') return Math.SQRT2 * sizeMm;
  return sizeMm;
}
