import { describe, expect, it } from "vitest";

import { featureRows, historyTotals, resetsIn, shareLabel, shareUsed, tokenCount, tokenShort, usageLevel } from "@/lib/ai/usage";
import type { AiUsage } from "@/lib/api/ai-usage";

const totals = (inputTokens: number, outputTokens: number, calls: number) => ({ tokens: inputTokens + outputTokens, inputTokens, outputTokens, calls });
const usage = (over: Partial<AiUsage> = {}): AiUsage => ({
  day: "2026-11-28", resetsAt: "2026-11-29T00:00:00.000Z",
  organization: { ...totals(7800, 1000, 5), dailyLimit: 20_000_000 },
  user: { ...totals(2500, 150, 2), tokensEverywhere: 9000, dailyLimit: 2_000_000 },
  features: [
    { feature: "copilot", ...totals(3300, 350, 3) }, { feature: "drawing_reading", ...totals(4000, 600, 1) },
    { feature: "vave", ...totals(500, 50, 1) }, { feature: "other", ...totals(0, 0, 0) },
  ],
  history: [{ date: "2026-11-26", tokens: 7066, calls: 2 }, { date: "2026-11-27", tokens: 6104, calls: 1 }, { date: "2026-11-28", tokens: 8800, calls: 5 }],
  ...over,
});

describe("token counts", () => {
  it("writes a count in full with separators", () => {
    expect(tokenCount(0)).toBe("0");
    expect(tokenCount(6104)).toBe("6,104");
    expect(tokenCount(19_991_200)).toBe("19,991,200");
  });

  it("shortens a count for a tight space, never rounding up past what was spent", () => {
    expect(tokenShort(950)).toBe("950");
    expect(tokenShort(6104)).toBe("6.1K");
    expect(tokenShort(999_999)).toBe("999K");
    expect(tokenShort(2_000_000)).toBe("2M");
    expect(tokenShort(20_000_000)).toBe("20M");
    expect(tokenShort(1_250_000_000)).toBe("1.2B");
  });
});

describe("share of an allowance", () => {
  it("is the used part in percent, held between 0 and 100", () => {
    expect(shareUsed(8800, 20_000_000)).toBeCloseTo(0.044, 6);
    expect(shareUsed(30, 20)).toBe(100);
    expect(shareUsed(0, 0)).toBe(0);
    expect(shareUsed(5, 0)).toBe(100);
  });

  it("is worded so a trace is not shown as nothing", () => {
    expect(shareLabel(0)).toBe("0%");
    expect(shareLabel(0.044)).toBe("<0.1%");
    expect(shareLabel(4.26)).toBe("4.3%");
    expect(shareLabel(71.4)).toBe("71%");
  });

  it("turns amber above 65% and red above 85%", () => {
    expect([10, 65, 66, 85, 86].map(usageLevel)).toEqual(["ok", "ok", "high", "high", "critical"]);
  });
});

describe("resetsIn", () => {
  it("says how long until the allowances start again", () => {
    expect(resetsIn("2026-11-29T00:00:00.000Z", new Date("2026-11-28T09:30:00Z"))).toBe("in 14 h 30 min");
    expect(resetsIn("2026-11-29T00:00:00.000Z", new Date("2026-11-28T22:00:00Z"))).toBe("in 2 h");
    expect(resetsIn("2026-11-29T00:00:00.000Z", new Date("2026-11-28T23:48:10Z"))).toBe("in 12 min");
    expect(resetsIn("2026-11-29T00:00:00.000Z", new Date("2026-11-29T00:00:05Z"))).toBe("now");
  });
});

describe("featureRows", () => {
  it("shows the three named features always, each with its share of today's tokens, and Other only when it holds usage", () => {
    const rows = featureRows(usage());
    expect(rows.map((r) => r.label)).toEqual(["Manufacturing Copilot", "Drawing reading", "VAVE and benchmark analysis"]);
    expect(rows[0]).toMatchObject({ tokens: 3650, calls: 3 });
    expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(100, 6);
    const withOther = usage({ features: [...usage().features.slice(0, 3), { feature: "other", ...totals(100, 4, 1) }] });
    expect(featureRows(withOther).map((r) => r.label)).toContain("Other");
  });

  it("has no share to show on a day nothing was spent", () => {
    const quiet = usage({ organization: { ...totals(0, 0, 0), dailyLimit: 20_000_000 }, features: usage().features.map((f) => ({ ...f, ...totals(0, 0, 0) })) });
    expect(featureRows(quiet).map((r) => r.share)).toEqual([0, 0, 0]);
  });
});

describe("historyTotals", () => {
  it("adds up the days", () => {
    expect(historyTotals(usage())).toEqual({ tokens: 21_970, calls: 8 });
  });
});
