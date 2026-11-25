import type { MaterialClass } from '../process/cost-machining-engine';

// The machining workbook's cutting data (memory/Machining - Calculator Database (1).xlsx, staged by migration 1137 from
// memory/machining/workbook/*.csv). Every cutting sheet times an operation the same way: spindle speed n = 1000 v / (pi D),
// passes, the cut length plus an approach allowance over the feed. These resolve v and the feed for a material and a size.
//
// The workbook gives most values as a range ("110-160 m/min"). A range is kept whole here (min and max) and picked inside by
// the calculator's own Range Position field, so the choice is visible on the line and can be changed there.
//
// Every match stays inside the table: a size outside the workbook's bands, or a material the workbook has no row for, is null
// and the caller names the gap. Nothing is extrapolated.

export const WORKBOOK_TABLES = [
  'tblTurningConditions', 'tblDrillReamData', 'tblHssHoleSpeeds', 'tblBoringFeed', 'tblMillingConditions',
  'tblCorraxCutData', 'tblCuttingToolCost', 'tblThermalCutFeed', 'tblSawCutRate', 'tblCuttingMaterialGroup',
  // Staged by migration 1154 (the same generator): Haas Tooling's ball nose end mill data, for the fillets and grooves a ball nose finishes.
  'tblBallNoseCutData',
] as const;
export type WorkbookTable = (typeof WORKBOOK_TABLES)[number];

export interface MaterialGroupRow {
  MaterialClass: MaterialClass;
  TurningGroup: string | null;
  DrillReamMaterial: string;
  HssGroup: string | null;
  MillingMaterial: string;
  CorraxData: boolean;
}
export interface TurningConditionsRow {
  WorkGroup: string; ToolMaterial: string;
  DepthMinMm: number; DepthMaxMm: number;
  FeedMinMmPerRev: number; FeedMaxMmPerRev: number;
  SpeedMinMPerMin: number; SpeedMaxMPerMin: number;
}
export interface DrillReamRow {
  WorkMaterial: string; Operation: 'Drilling' | 'Reaming';
  SpeedMinMPerMin: number; SpeedMaxMPerMin: number;
  DiameterMinMm: number; DiameterMaxMm: number; FeedMmPerRev: number;
}
export interface HssHoleSpeedRow { WorkGroup: string; Operation: 'Drilling' | 'Reaming' | 'Tapping'; SpeedMinMPerMin: number; SpeedMaxMPerMin: number }
export interface BoringFeedRow { DiameterMinMm: number; DiameterMaxMm: number | null; FeedMinMmPerRev: number; FeedMaxMmPerRev: number }
export interface MillingConditionsRow { WorkMaterial: string; SpeedMinMPerMin: number; SpeedMaxMPerMin: number; FeedPerToothMinMm: number; FeedPerToothMaxMm: number }
export interface ToolCostRow { Tool: string; PriceInr: number; ToolLifeParts: number; WorkbookSheets: string; PriceSource: string }
export interface ThermalCutFeedRow { Machine: string; ThicknessMm: number; FeedMmPerMin: number; KerfMm: number }
export interface SawCutRateRow { Machine: string; AreaRateMm2PerMin: number }

/** A workbook range, kept whole: the calculator picks inside it. */
export interface Range { min: number; max: number }

/** The value at `position` (0 = the range's low end, 1 = its high end, 0.5 = its middle). */
export function valueInRange(r: Range, position: number): number {
  const p = Math.min(1, Math.max(0, position));
  return r.min + p * (r.max - r.min);
}

/** The material's row of the class-to-workbook map, or null when the class is not mapped. */
export function materialGroup(rows: MaterialGroupRow[], materialClass: MaterialClass): MaterialGroupRow | null {
  return rows.find((r) => r.MaterialClass === materialClass) ?? null;
}

/**
 * The band a size falls in. The workbook's bands are written with gaps and overlaps ("1-3, 4-6, 6-9, 10-13": a 3.5 mm hole is in
 * none, a 6 mm hole in two). A band here runs from the end of the band below it to its own maximum, so each size has one band:
 * 3.5 mm is in "4-6", 6 mm in "4-6". The first band starts at its own minimum; an open last band ("over 38") has no maximum.
 */
function bandIndex(bands: { min: number; max: number | null }[], size: number): number | null {
  if (!Number.isFinite(size) || bands.length === 0) return null;
  const sorted = bands.map((b, i) => ({ ...b, i })).sort((a, b) => a.min - b.min);
  if (size < sorted[0].min) return null;
  for (const b of sorted) {
    if (b.max == null || size <= b.max) return b.i;
  }
  return null;
}

/** The row whose `minColumn`..`maxColumn` band holds `size`, by the same rule (an empty max is an open last band); null outside. */
export function rowInBand<T extends Record<string, unknown>>(rows: readonly T[], minColumn: string, maxColumn: string, size: number): T | null {
  const bands = rows.map((r) => ({ min: Number(r[minColumn]), max: r[maxColumn] == null || r[maxColumn] === '' ? null : Number(r[maxColumn]) }));
  if (bands.some((b) => !Number.isFinite(b.min))) return null;
  const i = bandIndex(bands, size);
  return i == null ? null : rows[i];
}

/** Turning cutting conditions for a depth of cut: the band holding the depth, its feed and speed ranges. */
export function turningConditions(
  rows: TurningConditionsRow[], group: string, toolMaterial: 'HSS' | 'Carbide', depthOfCutMm: number,
): { speed: Range; feed: Range; depth: Range } | null {
  const own = rows.filter((r) => r.WorkGroup === group && r.ToolMaterial === toolMaterial);
  const i = bandIndex(own.map((r) => ({ min: r.DepthMinMm, max: r.DepthMaxMm })), depthOfCutMm);
  if (i == null) return null;
  const r = own[i];
  return {
    speed: { min: r.SpeedMinMPerMin, max: r.SpeedMaxMPerMin },
    feed: { min: r.FeedMinMmPerRev, max: r.FeedMaxMmPerRev },
    depth: { min: r.DepthMinMm, max: r.DepthMaxMm },
  };
}

/** Drilling or reaming speed range and the feed of the hole diameter's band. */
export function drillReamData(
  rows: DrillReamRow[], material: string, operation: 'Drilling' | 'Reaming', diameterMm: number,
): { speed: Range; feedMmPerRev: number; band: Range } | null {
  const own = rows.filter((r) => r.WorkMaterial === material && r.Operation === operation);
  const i = bandIndex(own.map((r) => ({ min: r.DiameterMinMm, max: r.DiameterMaxMm })), diameterMm);
  if (i == null) return null;
  const r = own[i];
  return { speed: { min: r.SpeedMinMPerMin, max: r.SpeedMaxMPerMin }, feedMmPerRev: r.FeedMmPerRev, band: { min: r.DiameterMinMm, max: r.DiameterMaxMm } };
}

/** HSS cutting speed range for drilling, reaming or tapping. */
export function hssHoleSpeed(rows: HssHoleSpeedRow[], group: string, operation: HssHoleSpeedRow['Operation']): Range | null {
  const r = rows.find((x) => x.WorkGroup === group && x.Operation === operation);
  return r ? { min: r.SpeedMinMPerMin, max: r.SpeedMaxMPerMin } : null;
}

/** Boring feed range of the hole diameter's band. */
export function boringFeed(rows: BoringFeedRow[], diameterMm: number): Range | null {
  const i = bandIndex(rows.map((r) => ({ min: r.DiameterMinMm, max: r.DiameterMaxMm })), diameterMm);
  return i == null ? null : { min: rows[i].FeedMinMmPerRev, max: rows[i].FeedMaxMmPerRev };
}

/** Milling cutting speed and feed per tooth ranges. */
export function millingConditions(rows: MillingConditionsRow[], material: string): { speed: Range; feedPerTooth: Range } | null {
  const r = rows.find((x) => x.WorkMaterial === material);
  return r ? { speed: { min: r.SpeedMinMPerMin, max: r.SpeedMaxMPerMin }, feedPerTooth: { min: r.FeedPerToothMinMm, max: r.FeedPerToothMaxMm } } : null;
}

/** A tool's price and life: its cost per part is price / life. */
export function toolCost(rows: ToolCostRow[], tool: string): ToolCostRow | null {
  return rows.find((r) => r.Tool === tool) ?? null;
}

/**
 * Feed and kerf of a thermal cutting machine for a thickness: the row at the thickness or the next thicker one the table gives
 * (cutting slower than the thinner row allows would not cut through). Thicker than the table's thickest row is null.
 */
export function thermalCutFeed(rows: ThermalCutFeedRow[], machine: string, thicknessMm: number): ThermalCutFeedRow | null {
  if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) return null;
  const own = rows.filter((r) => r.Machine === machine).sort((a, b) => a.ThicknessMm - b.ThicknessMm);
  return own.find((r) => r.ThicknessMm >= thicknessMm) ?? null;
}
