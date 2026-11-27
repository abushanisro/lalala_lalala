import { describe, expect, it } from "vitest";

import type { BomCost, CostAnalytics, PartCostRow } from "@/lib/api/cost-analytics";
import {
  basisOf, concentration, decades, driverRows, elementRows, gapRows, kg, money, pareto, plural, ratios, savingsBridge, utilisationRows, weeklyCosted, weightRows,
} from "@/lib/dashboard/cost-analytics";

const part = (name: string, unitCost: number, over: Partial<PartCostRow> = {}): PartCostRow => ({
  id: name, name, partNumber: null, bomId: "bom", bomName: "BOM", projectId: "p", unitCost,
  elements: { rawMaterial: unitCost * 0.6, process: unitCost * 0.4, tooling: 0, packagingLogistics: 0, procuredParts: 0 },
  annualVolume: 100, annualSpend: unitCost * 100, weightKg: null, cycleTimeS: 0, costedAt: null, askPrice: null, gap: null, annualGap: null, ...over,
});
const bom = (name: string, askAnnual: number, askShouldCostAnnual: number): BomCost => ({
  id: name, name, projectId: "p", projectName: "P", parts: 1, costed: 1, unitCost: 0, annualSpend: 0,
  elements: { rawMaterial: 0, process: 0, tooling: 0, packagingLogistics: 0, procuredParts: 0 }, askAnnual, askShouldCostAnnual,
});
function analytics(parts: PartCostRow[], over: Partial<CostAnalytics> = {}): CostAnalytics {
  const unitCost = parts.reduce((s, p) => s + p.unitCost, 0);
  const annualSpend = parts.reduce((s, p) => s + (p.annualSpend ?? 0), 0);
  const element = (share: number) => ({ unitCost: unitCost * share, annualSpend: annualSpend * share });
  return {
    currency: "INR", fxRates: {},
    coverage: { parts: parts.length + 2, costed: parts.length, notCosted: 2, unresolved: 0, withAnnualVolume: parts.filter(p => p.annualVolume != null).length, withAskPrice: 0, askPriceUnconverted: 0 },
    totals: { unitCost, annualSpend, annualHours: 0, grossKg: 50, netKg: 10,
      elements: { rawMaterial: element(0.6), process: element(0.4), tooling: element(0), packagingLogistics: element(0), procuredParts: element(0) } },
    savings: { parts: 0, askAnnual: 0, shouldCostAnnual: 0, opportunityAnnual: 0, partsAboveShouldCost: 0, partsBelowShouldCost: 0, shortfallAnnual: 0 },
    drivers: [], parts, partsOmitted: 0, processGroups: [], machines: [], materials: [], boms: [], ...over,
  };
}

describe("money", () => {
  it("writes rupees in lakh and crore and other currencies in thousands and millions", () => {
    expect(money(156027, "INR")).toBe("₹1,56,027");
    expect(money(1560274886, "INR", true)).toBe("₹156Cr");
    expect(money(1661.11, "USD")).toBe("$1,661");
    expect(money(2_400_000, "USD", true)).toBe("$2.4M");
    expect(money(7.5, "USD")).toBe("$7.50");
  });

  it("shows a dash for an amount that is not there, never a zero", () => {
    expect(money(null, "INR")).toBe("—");
    expect(money(Number.NaN, "USD")).toBe("—");
  });
});

describe("counts, weights and log axes", () => {
  it("writes one part and several parts, and a weight to the figures that matter at its size", () => {
    expect([plural(1, "part"), plural(13, "part"), plural(1200, "operation")]).toEqual(["1 part", "13 parts", "1,200 operations"]);
    expect([kg(333.3), kg(38.2), kg(8.314), kg(0.0723), kg(0.007)]).toEqual(["333 kg", "38.2 kg", "8.31 kg", "0.072 kg", "0.007 kg"]);
  });

  it("puts a log axis on whole decades that hold every value", () => {
    expect(decades([0.007, 0.04, 13.2])).toEqual([0.001, 0.01, 0.1, 1, 10, 100]);
    expect(decades([5])).toEqual([1, 10]);
    expect(decades([100])).toEqual([100, 1000]);
    expect(decades([])).toEqual([1, 10]);
  });
});

describe("the headline ratios", () => {
  it("are shares of the costed parts, and null when there is nothing to take a share of", () => {
    const a = analytics([part("a", 300), part("b", 100)]);
    expect(ratios(a)).toMatchObject({ coverage: 0.5, averageUnitCost: 200, materialShare: 0.6, utilisation: 0.2, opportunity: null });
    const empty = analytics([], { totals: { ...a.totals, unitCost: 0, grossKg: 0, netKg: 0 } });
    expect(ratios(empty)).toMatchObject({ averageUnitCost: null, materialShare: null, utilisation: null });
  });
});

describe("basis", () => {
  it("is the year when the costed parts have annual volumes, and one of each part when none has", () => {
    expect(basisOf(analytics([part("a", 10)]))).toBe("annual");
    expect(basisOf(analytics([part("a", 10, { annualVolume: null, annualSpend: null })]))).toBe("unit");
  });
});

describe("elementRows", () => {
  it("keeps the elements that carry money, in their fixed order, with their shares", () => {
    const rows = elementRows(analytics([part("a", 100)]), "annual");
    expect(rows.map(r => [r.label, r.value, r.share])).toEqual([["Material", 6000, 0.6], ["Process", 4000, 0.4]]);
  });
});

describe("driverRows", () => {
  it("names each driver, says what moves it, and ranks them by the money they carry", () => {
    const a = analytics([part("a", 100)], { drivers: [
      { key: "labourTime", unitCost: 30, annualSpend: 3000 }, { key: "materialRemoved", unitCost: 45, annualSpend: 4500 },
      { key: "machineTime", unitCost: 10, annualSpend: 1000 }, { key: "materialInPart", unitCost: 15, annualSpend: 1500 }, { key: "setup", unitCost: 0, annualSpend: 0 },
    ] });
    const rows = driverRows(a, "annual");
    expect(rows.map(r => [r.label, r.value, r.share])).toEqual([
      ["Material machined or cut away", 4500, 0.45], ["Labour time", 3000, 0.3], ["Material left in the part", 1500, 0.15], ["Machine time", 1000, 0.1],
    ]);
    expect(rows[0]).toMatchObject({ element: "rawMaterial", movedBy: "stock weight less part weight, × material price, less scrap credit" });
    expect(rows[1]).toMatchObject({ element: "process", movedBy: "cycle time × labour rate" });
  });
});

describe("pareto", () => {
  it("lists the costliest parts first with the share reached so far", () => {
    const rows = pareto(analytics([part("small", 10), part("big", 70), part("mid", 20)]), "annual", 2);
    expect(rows.map(r => [r.name, r.value, r.share, r.cumulativeShare])).toEqual([["big", 7000, 0.7, 0.7], ["mid", 2000, 0.2, 0.9]]);
  });

  it("says how much the costliest fifth of the parts carries", () => {
    const parts = [part("a", 60), part("b", 10), part("c", 10), part("d", 10), part("e", 10)];
    expect(concentration(analytics(parts), "unit")).toEqual({ parts: 1, share: 0.6 });
    expect(concentration(analytics(parts, { partsOmitted: 3 }), "unit")).toBeNull();          // not every part is in hand
    expect(concentration(analytics([]), "unit")).toBeNull();
  });
});

describe("the gap to the ask price", () => {
  it("lists the priced parts by the money at stake in a year, largest first", () => {
    const rows = gapRows([
      part("unpriced", 50),
      part("small volume", 100, { askPrice: 200, gap: 100, annualGap: 100 * 10 }),
      part("large volume", 100, { askPrice: 120, gap: 20, annualGap: 20 * 1000 }),
      part("below", 100, { askPrice: 90, gap: -10, annualGap: -1000 }),
    ]);
    expect(rows.map(r => r.name)).toEqual(["large volume", "small volume", "below"]);
    expect(rows[0]).toMatchObject({ askPrice: 120, unitCost: 100, gap: 20, annualGap: 20_000 });
    expect(rows[0].gapShare).toBeCloseTo(1 / 6);
  });

  it("bridges from the ask price to the should-cost by BOM, and a BOM priced below its should-cost steps up", () => {
    const a = analytics([], {
      savings: { parts: 3, askAnnual: 1000, shouldCostAnnual: 760, opportunityAnnual: 300, partsAboveShouldCost: 2, partsBelowShouldCost: 1, shortfallAnnual: 60 },
      boms: [bom("Chamber", 600, 350), bom("Flare", 100, 160), bom("Build", 300, 250), bom("Unpriced", 0, 0)],
    });
    expect(savingsBridge(a)).toEqual([
      { name: "Ask price", kind: "total", from: 0, to: 1000, value: 1000 },
      { name: "Chamber", kind: "saving", from: 1000, to: 750, value: -250 },
      { name: "Flare", kind: "increase", from: 750, to: 810, value: 60 },
      { name: "Build", kind: "saving", from: 810, to: 760, value: -50 },
      { name: "Should-cost", kind: "total", from: 0, to: 760, value: 760 },
    ]);
    expect(savingsBridge(a, 1).map(s => s.name)).toEqual(["Ask price", "Chamber", "Other BOMs", "Should-cost"]);
    expect(savingsBridge(analytics([]))).toEqual([]);
  });
});

describe("material and weight", () => {
  it("gives the share of the stock bought that stays in the parts, for materials whose records state weights", () => {
    expect(utilisationRows([
      { name: "Aluminum 6061", parts: 9, unitCost: 0, annualSpend: 0, grossKg: 244.7, netKg: 40.1 },
      { name: "No weights", parts: 1, unitCost: 0, annualSpend: 0, grossKg: 0, netKg: 0 },
    ])).toEqual([{ name: "Aluminum 6061", utilisation: 40.1 / 244.7, grossKg: 244.7, netKg: 40.1 }]);
  });

  it("gives cost a kilogram for parts with a weight", () => {
    expect(weightRows([part("a", 500, { weightKg: 2 }), part("b", 500)])).toEqual([{ id: "a", name: "a", weightKg: 2, unitCost: 500, costPerKg: 250 }]);
  });
});

describe("weeklyCosted", () => {
  it("counts parts by the week they were first costed, the current week last", () => {
    const now = new Date("2026-11-27T12:00:00Z");                                    // a Friday; its week starts Monday 23 Nov
    const rows = weeklyCosted([
      part("this week", 1, { costedAt: "2026-11-27T09:00:00Z" }), part("monday", 1, { costedAt: "2026-11-23T00:00:00Z" }),
      part("last week", 1, { costedAt: "2026-11-22T23:59:00Z" }), part("long ago", 1, { costedAt: "2026-01-05T00:00:00Z" }), part("undated", 1),
    ], now, 3);
    expect(rows).toEqual([
      { start: "2026-11-09", label: "9 Nov", parts: 0 }, { start: "2026-11-16", label: "16 Nov", parts: 1 }, { start: "2026-11-23", label: "23 Nov", parts: 2 },
    ]);
  });
});
