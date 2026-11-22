import type { BOMItem, CostSummaryDto } from '@/lib/api/hooks/useBOMItems';

export type RollFormingSummary = NonNullable<CostSummaryDto['rollForming']>;
export type RollFormingTooling = NonNullable<CostSummaryDto['rollFormingTooling']>;

/** The process group of roll forming (backend part-family-process-group.ts ROLL_FORMING_PROCESS_GROUP). */
export const ROLL_FORMING_PROCESS_GROUP = 'Sheet Metal Roll Forming';

/** Whether an item is roll formed: its Process is Sheet Metal Roll Forming (the backend's isRollForming). */
export function isRollFormingItem(item: Pick<BOMItem, 'scenarioOverrides'> | null | undefined): boolean {
  return item?.scenarioOverrides?.processGroup === ROLL_FORMING_PROCESS_GROUP;
}

/** The Cost Guide keys of a roll formed part (backend roll-forming-route.ts ROLL_FORMING_KEYS). */
export const ROLL_FORMING_SCENARIO_KEYS = {
  stations: 'rollFormStations', cutOff: 'rollFormCutOff', welding: 'rollFormWelding', toolingMultiplier: 'rollFormToolingMultiplier',
} as const;

/** The two routes, by how the part is cut off the line (backend roll-forming-route.ts ROLL_FORMING_ROUTES). */
export const ROLL_FORMING_ROUTE_OPTIONS = [
  { key: 'scissor', label: 'Scissor Cut-Off' },
  { key: 'blade', label: 'Blade Cut-Off' },
] as const;

/** The integrated welding processes of a closed section (backend roll-forming-route.ts WELDING_PROCESS). */
export const ROLL_FORMING_WELDING_OPTIONS = [
  { key: 'hfi', label: 'Integrated HFI Welding' },
  { key: 'laser', label: 'Integrated Laser Welding' },
  { key: 'rotary-spot', label: 'Integrated Rotary Spot Welding' },
  { key: 'tig', label: 'Integrated TIG Welding' },
] as const;

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pick = <T extends readonly { key: string }[]>(options: T, v: unknown): T[number]['key'] | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return options.find((o) => o.key === s)?.key ?? null;
};

/** The Cost Guide's settings, each null when not set (the engine decides), read as the backend reads them (rollFormingOverrides). */
export function rollFormingOverridesOf(overrides: Record<string, unknown> | null | undefined): {
  cutOff: string | null; welding: string | null; stations: number | null; toolingMultiplier: number | null;
} {
  const o = overrides ?? {};
  const stations = num(o[ROLL_FORMING_SCENARIO_KEYS.stations]);
  const multiplier = num(o[ROLL_FORMING_SCENARIO_KEYS.toolingMultiplier]);
  return {
    cutOff: pick(ROLL_FORMING_ROUTE_OPTIONS, o[ROLL_FORMING_SCENARIO_KEYS.cutOff]),
    welding: pick(ROLL_FORMING_WELDING_OPTIONS, o[ROLL_FORMING_SCENARIO_KEYS.welding]),
    stations: stations != null && stations >= 1 ? Math.round(stations) : null,
    toolingMultiplier: multiplier != null && multiplier > 0 ? multiplier : null,
  };
}

const n = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-US');

/**
 * The stations as an engineer reads them: "level 1: 2 bends to 90° at 15°/pass → 6 · finishing 1 = 7"; a level whose flange is long enough
 * to limit the angle a pass forms (Bhattacharyya's deformation length over the mill's stand spacing) says so: "at 8.3°/pass (100 mm flange)".
 */
export function stationsLine(s: RollFormingSummary['stations']): string {
  const perPass = (l: RollFormingSummary['stations']['levels'][number]) => (l.degreesPerPass == null ? ''
    : ` at ${n(l.degreesPerPass)}°/pass${l.governedBy === 'flange length' && l.flangeCarriedMm != null ? ` (${n(l.flangeCarriedMm)} mm flange)` : ''}`);
  const levels = s.levels.map((l) => `level ${l.level}: ${l.bends} bend${l.bends === 1 ? '' : 's'} to ${n(l.maxAngleDeg)}°${perPass(l)} → ${l.passes}`);
  const parts = [...levels, ...(s.leadIn > 0 ? [`lead-in ${s.leadIn}`] : []), ...(s.finishing > 0 ? [`finishing ${s.finishing}`] : [])];
  return `${parts.join(' · ')} = ${s.rule}`;
}

/** The line speed and what sets it: "660 mm/s, set by the part-length tolerance". */
export function lineSpeedLine(l: NonNullable<RollFormingSummary['lineSpeed']>): string {
  return `${Math.round(l.mmPerS).toLocaleString('en-US')} mm/s${l.limiting ? `, set by ${l.limiting}` : ''}`;
}

/** The coil: "1,234 kg coil · 540 parts · change 1,020 s (end weld) → 1.9 s a part". */
export function coilLine(c: NonNullable<RollFormingSummary['coil']>): string {
  return `${Math.round(c.massKg).toLocaleString('en-US')} kg coil · ${c.partsPerCoil.toLocaleString('en-US')} parts · change ${Math.round(c.changeTimeS).toLocaleString('en-US')} s (${c.method}) → ${n(c.perPartS)} s a part`;
}

/** A closed section's outside sizes: "Ø50 x 2 mm wall" for a round tube, "40 x 40 x 1.5 mm wall" for any other. */
export function tubeLine(t: NonNullable<RollFormingSummary['section']['tube']>): string {
  const wall = t.wallMm != null ? ` x ${n(t.wallMm)} mm wall` : '';
  if (t.outerDiameterMm != null) return `Ø${n(t.outerDiameterMm)}${wall}`;
  const size = t.outerWidthMm != null && t.outerHeightMm != null ? `${n(t.outerWidthMm)} x ${n(t.outerHeightMm)}` : 'outside not measured';
  return `${size}${wall}`;
}

/** The ribs found (bends counted from 1 across the strip): "rib, bends 2-3, 46.9 mm span, formed at level 1"; empty when there is none. */
export function ribLines(groups: NonNullable<RollFormingSummary['stations']['groups']>): string[] {
  return groups.filter((g) => g.rib).map((g) => [
    `rib, bends ${g.firstBend + 1}-${g.lastBend + 1}`,
    ...(g.spanMm != null ? [`${n(g.spanMm)} mm span`] : []),
    ...(g.level != null ? [`formed at level ${g.level}`] : []),
  ].join(', '));
}

/** The sharp bends' effect on the strip: "strip 0.6 mm narrower for it (measured 120)"; null when it does not change. */
export function sharpStripLine(changeMm: number | undefined, measuredWidthMm: number | undefined): string | null {
  if (changeMm == null || Math.abs(changeMm) < 0.005) return null;
  return `strip ${n(Math.abs(changeMm))} mm ${changeMm < 0 ? 'narrower' : 'wider'} for it${measuredWidthMm != null ? ` (measured ${n(measuredWidthMm)})` : ''}`;
}
