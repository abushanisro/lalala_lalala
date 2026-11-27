import type { BomCost, CostAnalytics, CostDriver, CostElement, MaterialCost, PartCostRow } from "@/lib/api/cost-analytics";

/** The cost elements in the order they are shown. */
export const COST_ELEMENTS: readonly CostElement[] = ["rawMaterial", "process", "tooling", "packagingLogistics", "procuredParts"];

export const ELEMENT_LABEL: Record<CostElement, string> = {
  rawMaterial: "Material",
  process: "Process",
  tooling: "Tooling",
  packagingLogistics: "Packaging and logistics",
  procuredParts: "Procured parts",
};

/** Money in the workspace currency: lakh and crore for rupees, and a short form (1.6L, 2.4M) for axes and tiles. */
export function money(amount: number | null | undefined, currency: string, compact = false): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const small = Math.abs(amount) < 100;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: compact ? 0 : small ? 2 : 0,
    maximumFractionDigits: compact ? 1 : small ? 2 : 0,
  }).format(amount);
}

export const count = (n: number): string => Math.round(n).toLocaleString("en-US");
/** "1 part", "13 parts". */
export const plural = (n: number, one: string): string => `${count(n)} ${one}${Math.round(n) === 1 ? "" : "s"}`;
/** A weight to the figures that matter at its size: 333 kg, 38.2 kg, 8.31 kg, 0.072 kg. */
export const kg = (v: number): string =>
  `${v >= 100 ? count(v) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : String(Number(v.toPrecision(2)))} kg`;
/** Whole decades from the one at or below the smallest value to the one at or above the largest: the ticks of a log axis. */
export function decades(values: readonly number[]): number[] {
  const positive = values.filter(v => v > 0);
  if (!positive.length) return [1, 10];
  const low = Math.floor(Math.log10(Math.min(...positive))), high = Math.max(low + 1, Math.ceil(Math.log10(Math.max(...positive))));
  return Array.from({ length: high - low + 1 }, (_, i) => Number(`1e${low + i}`));
}
export const percent = (share: number | null, digits = 0): string => (share == null ? "—" : `${(share * 100).toFixed(digits)}%`);
const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/** Annual figures when the costed parts have annual volumes; otherwise the cost of one of each part. */
export type Basis = "annual" | "unit";
export const basisOf = (a: CostAnalytics): Basis => (a.coverage.withAnnualVolume > 0 ? "annual" : "unit");
export const basisLabel = (basis: Basis): string => (basis === "annual" ? "a year" : "for one of each part");
const valueOf = (row: { unitCost: number; annualSpend: number | null }, basis: Basis): number =>
  basis === "annual" ? row.annualSpend ?? 0 : row.unitCost;
const totalOf = (a: CostAnalytics, basis: Basis): number => (basis === "annual" ? a.totals.annualSpend : a.totals.unitCost);

/** The headline ratios. Each is null when what it is a share of is zero, so a tile can say so and not show 0 %. */
export function ratios(a: CostAnalytics) {
  return {
    coverage: share(a.coverage.costed, a.coverage.parts),
    averageUnitCost: a.coverage.costed > 0 ? a.totals.unitCost / a.coverage.costed : null,
    materialShare: share(a.totals.elements.rawMaterial.unitCost, a.totals.unitCost),
    /** Material left in the parts over stock bought. */
    utilisation: share(a.totals.netKg, a.totals.grossKg),
    /** The savings opportunity over what is asked for the priced parts. */
    opportunity: share(a.savings.opportunityAnnual, a.savings.askAnnual),
  };
}

export interface ElementRow { key: CostElement; label: string; value: number; share: number }

/** The cost elements that carry money, in their fixed order. */
export function elementRows(a: CostAnalytics, basis: Basis): ElementRow[] {
  const total = totalOf(a, basis);
  return COST_ELEMENTS
    .map(key => ({ key, label: ELEMENT_LABEL[key], value: basis === "annual" ? a.totals.elements[key].annualSpend : a.totals.elements[key].unitCost }))
    .filter(row => row.value > 0)
    .map(row => ({ ...row, share: total > 0 ? row.value / total : 0 }));
}

/** Each driver: what it is called, the element it belongs to, and what moves it. */
export const DRIVER: Record<CostDriver, { label: string; element: CostElement; movedBy: string }> = {
  machineTime: { label: "Machine time", element: "process", movedBy: "cycle time × machine rate" },
  labourTime: { label: "Labour time", element: "process", movedBy: "cycle time × labour rate" },
  setup: { label: "Set-up", element: "process", movedBy: "set-up time, spread over the batch" },
  processScrap: { label: "Process scrap allowance", element: "process", movedBy: "parts lost in the process" },
  processOther: { label: "Process cost, not broken down", element: "process", movedBy: "its records state no set-up and cycle split" },
  materialInPart: { label: "Material left in the part", element: "rawMaterial", movedBy: "part weight × material price" },
  materialRemoved: { label: "Material machined or cut away", element: "rawMaterial", movedBy: "stock weight less part weight, × material price, less scrap credit" },
  materialScrap: { label: "Material scrap allowance", element: "rawMaterial", movedBy: "stock lost to rejects" },
  materialOverhead: { label: "Material overhead", element: "rawMaterial", movedBy: "a percentage on the material bought" },
  materialOther: { label: "Material cost, not broken down", element: "rawMaterial", movedBy: "its records state no stock and part weights" },
  tooling: { label: "Tooling", element: "tooling", movedBy: "tool cost over the parts it makes" },
  packagingLogistics: { label: "Packaging and logistics", element: "packagingLogistics", movedBy: "pack and freight a part" },
  procuredParts: { label: "Procured parts", element: "procuredParts", movedBy: "bought-in price" },
};

export interface DriverRow { key: CostDriver; label: string; element: CostElement; movedBy: string; value: number; share: number }

/** What the should-cost is spent on, the largest driver first: where a cost reduction has the most to act on. */
export function driverRows(a: CostAnalytics, basis: Basis): DriverRow[] {
  const total = totalOf(a, basis);
  return a.drivers
    .map(d => ({ key: d.key, ...DRIVER[d.key], value: basis === "annual" ? d.annualSpend : d.unitCost }))
    .filter(row => row.value > 0)
    .sort((x, y) => y.value - x.value)
    .map(row => ({ ...row, share: total > 0 ? row.value / total : 0 }));
}

export interface ParetoRow { id: string; name: string; value: number; share: number; cumulativeShare: number }

/** The parts that cost the most, largest first, each with its share of the whole and the share reached so far. */
export function pareto(a: CostAnalytics, basis: Basis, rows = 12): ParetoRow[] {
  const total = totalOf(a, basis);
  if (!(total > 0)) return [];
  let running = 0;
  return [...a.parts]
    .sort((x, y) => valueOf(y, basis) - valueOf(x, basis))
    .slice(0, rows)
    .filter(p => valueOf(p, basis) > 0)
    .map(p => {
      running += valueOf(p, basis);
      return { id: p.id, name: p.name, value: valueOf(p, basis), share: valueOf(p, basis) / total, cumulativeShare: running / total };
    });
}

/** How concentrated the cost is: the share carried by the costliest fifth of the parts. */
export function concentration(a: CostAnalytics, basis: Basis): { parts: number; share: number } | null {
  const total = totalOf(a, basis);
  if (!(total > 0) || a.parts.length === 0 || a.partsOmitted > 0) return null;
  const top = Math.max(1, Math.ceil(a.parts.length / 5));
  const carried = [...a.parts].sort((x, y) => valueOf(y, basis) - valueOf(x, basis)).slice(0, top).reduce((sum, p) => sum + valueOf(p, basis), 0);
  return { parts: top, share: carried / total };
}

export interface GapRow { id: string; name: string; askPrice: number; unitCost: number; gap: number; gapShare: number | null; annualGap: number | null }

/** The parts with an ask price, the largest gap to should-cost first (by the year when volumes are known). */
export function gapRows(parts: readonly PartCostRow[], rows = 10): GapRow[] {
  return parts
    .filter((p): p is PartCostRow & { askPrice: number; gap: number } => p.askPrice != null && p.gap != null)
    .sort((x, y) => (y.annualGap ?? y.gap) - (x.annualGap ?? x.gap))
    .slice(0, rows)
    .map(p => ({ id: p.id, name: p.name, askPrice: p.askPrice, unitCost: p.unitCost, gap: p.gap, gapShare: share(p.gap, p.askPrice), annualGap: p.annualGap }));
}

export interface BridgeStep {
  name: string;
  /** A total stands on the axis; a change hangs from the level before it. */
  kind: "total" | "saving" | "increase";
  /** The bar runs from `from` to `to`. */
  from: number;
  to: number;
  value: number;
}

/**
 * From what is asked to what the parts should cost, a year: one step per BOM (the largest first, the rest together). A BOM priced
 * below its should-cost steps up, so it cannot hide inside another BOM's saving.
 */
export function savingsBridge(a: CostAnalytics, steps = 5): BridgeStep[] {
  if (!(a.savings.askAnnual > 0)) return [];
  const gaps = a.boms
    .map((b: BomCost) => ({ name: b.name, gap: b.askAnnual - b.askShouldCostAnnual }))
    .filter(b => b.gap !== 0)
    .sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
  const shown = gaps.slice(0, steps);
  const rest = gaps.slice(steps).reduce((sum, b) => sum + b.gap, 0);
  if (rest !== 0) shown.push({ name: "Other BOMs", gap: rest });
  const out: BridgeStep[] = [{ name: "Ask price", kind: "total", from: 0, to: a.savings.askAnnual, value: a.savings.askAnnual }];
  let level = a.savings.askAnnual;
  for (const b of shown) {
    out.push({ name: b.name, kind: b.gap > 0 ? "saving" : "increase", from: level, to: level - b.gap, value: -b.gap });
    level -= b.gap;
  }
  out.push({ name: "Should-cost", kind: "total", from: 0, to: a.savings.shouldCostAnnual, value: a.savings.shouldCostAnnual });
  return out;
}

export interface UtilisationRow { name: string; utilisation: number; grossKg: number; netKg: number }

/** Per material: the share of the stock bought that is left in the parts. Materials whose records state no weights are left out. */
export function utilisationRows(materials: readonly MaterialCost[], rows = 8): UtilisationRow[] {
  return materials
    .filter(m => m.grossKg > 0)
    .map(m => ({ name: m.name, utilisation: Math.min(1, m.netKg / m.grossKg), grossKg: m.grossKg, netKg: m.netKg }))
    .sort((x, y) => y.grossKg - x.grossKg)
    .slice(0, rows);
}

export interface WeightRow { id: string; name: string; weightKg: number; unitCost: number; costPerKg: number }

/** Parts with a weight: cost against weight shows the parts that cost far more a kilogram than the rest. */
export function weightRows(parts: readonly PartCostRow[]): WeightRow[] {
  return parts
    .filter((p): p is PartCostRow & { weightKg: number } => p.weightKg != null && p.weightKg > 0 && p.unitCost > 0)
    .map(p => ({ id: p.id, name: p.name, weightKg: p.weightKg, unitCost: p.unitCost, costPerKg: p.unitCost / p.weightKg }));
}

export interface WeekRow { start: string; label: string; parts: number }

/** Parts costed in each of the last `weeks` weeks (Monday to Sunday, UTC), the current week last. */
export function weeklyCosted(parts: readonly PartCostRow[], now: Date, weeks = 8): WeekRow[] {
  const day = 86_400_000;
  const monday = (d: Date) => {
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return midnight - ((d.getUTCDay() + 6) % 7) * day;
  };
  const last = monday(now);
  const rows = Array.from({ length: weeks }, (_, i) => {
    const start = new Date(last - (weeks - 1 - i) * 7 * day);
    return { start: start.toISOString().slice(0, 10), label: start.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }), parts: 0 };
  });
  for (const p of parts) {
    if (!p.costedAt) continue;
    const index = weeks - 1 - Math.round((last - monday(new Date(p.costedAt))) / (7 * day));
    const row = rows[index];
    if (row) row.parts++;
  }
  return rows;
}
