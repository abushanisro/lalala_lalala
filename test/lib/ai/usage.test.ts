import { describe, expect, it } from "vitest";

import {
  cacheReadShare, completeTo, featureRows, historyTotals, modelName, resetDay, resetsIn, shareLabel, shareUsed, tokenCount, tokenShort, usageLevel, usd, usdLimit, wholePercent,
} from "@/lib/ai/usage";
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
    expect(rows.map((r) => r.label)).toEqual(["Manufacturing Copilot", "Drawing reading and Ask", "VAVE and benchmark analysis"]);
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

describe("the Anthropic account's figures, worded as the Claude Console words them", () => {
  it("writes dollars with cents and separators, and a trace as less than a cent", () => {
    expect([3.5125, 1056.39, 0, 20].map(usd)).toEqual(["$3.51", "$1,056.39", "$0.00", "$20.00"]);
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(0.005)).toBe("$0.01");
  });

  it("writes a limit of whole dollars without cents", () => {
    expect([20, 1500, 12.5].map(usdLimit)).toEqual(["$20", "$1,500", "$12.50"]);
  });

  it("counts a share in whole percent, never rounded up, as the Console does", () => {
    expect([17.55, 99.9, 100, 1, 0.4, 0].map(wholePercent)).toEqual(["17%", "99%", "100%", "1%", "<1%", "0%"]);
  });

  it("says the day the month's limit starts again, in Anthropic's UTC month", () => {
    expect(resetDay("2026-12-01T00:00:00.000Z")).toBe("Dec 1");
    expect(resetDay("2027-01-01T00:00:00.000Z")).toBe("Jan 1");
  });

  it("gives the share of input tokens read from the cache, and none when there was no input", () => {
    expect(cacheReadShare({ uncachedInputTokens: 300, cacheReadTokens: 560, cacheWriteTokens: 140 })).toBeCloseTo(56, 6);
    expect(cacheReadShare({ uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
    expect(cacheReadShare({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it("names a model as people do, and leaves a name it does not know as it is", () => {
    expect(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-sonnet-4-5-20250929", "claude-opus-4-20250514"].map(modelName))
      .toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Fable 5.2", "Claude Sonnet 4.5", "Claude Opus 4"]);
    expect(["Other", "code-execution", ""].map(modelName)).toEqual(["Other", "code-execution", ""]);
  });

  it("says how far Anthropic's data is complete, in UTC", () => {
    const now = new Date("2026-11-28T09:40:00Z");
    expect(completeTo("2026-11-28T08:00:00Z", now)).toBe("08:00 UTC today");
    expect(completeTo("2026-11-27T22:00:00Z", now)).toBe("22:00 UTC, Nov 27");
    expect(completeTo(null, now)).toBeNull();
    expect(completeTo("not a time", now)).toBeNull();
  });
});

