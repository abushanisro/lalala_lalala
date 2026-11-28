// The AI usage figures as the app words them. Pure: only types come from the API module.
import type { AiFeature, AiUsage } from "@/lib/api/ai-usage";

export const AI_FEATURE_LABEL: Record<AiFeature, string> = {
  copilot: "Manufacturing Copilot",
  drawing_reading: "Drawing reading and Ask",
  vave: "VAVE and benchmark analysis",
  other: "Other",
};

/** A token count in full: 1234567 -> "1,234,567". */
export function tokenCount(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}

/** A token count for a tight space: 950 -> "950", 6104 -> "6.1K", 20000000 -> "20M". Never rounded up into the next unit's "1,000K". */
export function tokenShort(tokens: number): string {
  const n = Math.round(tokens);
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (n >= size) {
      const scaled = n / size;
      const text = scaled >= 100 ? Math.floor(scaled).toString() : (Math.floor(scaled * 10) / 10).toString();
      return `${text}${unit}`;
    }
  }
  return n.toString();
}

/** How much of an allowance is used, 0 to 100. An allowance of nothing (or less) counts as used up once anything is spent. */
export function shareUsed(used: number, limit: number): number {
  if (!(limit > 0)) return used > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

/** A share in words: "0%" for nothing, "<0.1%" for a trace, one decimal under 10%, whole numbers above. */
export function shareLabel(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.1) return "<0.1%";
  return share < 10 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`;
}

export type UsageLevel = "ok" | "high" | "critical";

/** When the bar turns amber and red: the same thresholds for every allowance. */
export function usageLevel(share: number): UsageLevel {
  return share > 85 ? "critical" : share > 65 ? "high" : "ok";
}

/** How long until the daily allowances start again: "in 14 h 30 min", "in 12 min", "now". */
export function resetsIn(resetsAt: string, now: Date): string {
  const minutes = Math.ceil((Date.parse(resetsAt) - now.getTime()) / 60_000);
  if (!(minutes > 0)) return "now";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h === 0 ? `in ${m} min` : m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}

/** The features to show: the three named ones always, "Other" only when it holds any usage. Each with its share of today's tokens. */
export function featureRows(usage: AiUsage): { feature: AiFeature; label: string; tokens: number; calls: number; share: number }[] {
  return usage.features
    .filter((f) => f.feature !== "other" || f.tokens > 0 || f.calls > 0)
    .map((f) => ({ feature: f.feature, label: AI_FEATURE_LABEL[f.feature], tokens: f.tokens, calls: f.calls, share: shareUsed(f.tokens, usage.organization.tokens) }));
}

/** The organization's tokens and AI calls over the days in `history` (the last 30). */
export function historyTotals(usage: AiUsage): { tokens: number; calls: number } {
  return usage.history.reduce((sum, d) => ({ tokens: sum.tokens + d.tokens, calls: sum.calls + d.calls }), { tokens: 0, calls: 0 });
}

// ── The Anthropic account's own figures (GET /ai-account-totals), worded as the Claude Console words them ─────────────────────────

/** Dollars as the Console writes them: 3.5125 -> "$3.51", 1056.39 -> "$1,056.39". An amount under a cent that is not nothing is "<$0.01". */
export function usd(amount: number): string {
  if (amount > 0 && amount < 0.005) return "<$0.01";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A limit as the Console writes it: whole dollars without cents ("$20"), otherwise with them ("$12.50"). */
export function usdLimit(amount: number): string {
  return Number.isInteger(amount) ? `$${amount.toLocaleString("en-US")}` : usd(amount);
}

/** A share as the Console counts it: whole percent, never rounded up (17.55 -> "17%"); a trace is "<1%". */
export function wholePercent(share: number): string {
  if (share <= 0) return "0%";
  return share < 1 ? "<1%" : `${Math.floor(share)}%`;
}

/** The day a monthly limit starts again, as the Console says it: "Dec 1". The month is Anthropic's, in UTC. */
export function resetDay(resetsAt: string): string {
  return new Date(resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The share of input tokens that were read from the prompt cache, 0 to 100. Null when there was no input at all. */
export function cacheReadShare(week: { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | null {
  const input = week.uncachedInputTokens + week.cacheReadTokens + week.cacheWriteTokens;
  return input > 0 ? (week.cacheReadTokens / input) * 100 : null;
}

/** A model as people name it: "claude-opus-5-5" -> "Claude Opus 5.5", with or without a date at its end. Any other name is left as it is. */
export function modelName(model: string): string {
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!parts) return model;
  const [, family = "", major = "", minor] = parts;
  return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

/** How far Anthropic's data is complete, in UTC as its reports are: "08:00 UTC today", "22:00 UTC, Nov 27". Null: it did not say. */
export function completeTo(asOf: string | null, now: Date): string | null {
  if (!asOf) return null;
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${at.toISOString().slice(11, 16)} UTC`;
  return at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10) ? `${time} today` : `${time}, ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}
