import { apiClient } from "@/lib/api/client";

/** What AI usage is shown by ("other" is usage recorded before features were named). */
export type AiFeature = "copilot" | "drawing_reading" | "vave" | "other";

/** `tokens` is input plus output; input includes what was written to and read from the prompt cache. */
export interface AiUsageTotals {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/** GET /ai-usage-totals: the AI tokens the organization has spent, from the usage each model response reported. Days are UTC days. */
export interface AiUsage {
  /** The UTC day the daily figures are for, and the moment it ends and the allowances start again. */
  day: string;
  resetsAt: string;
  /** Today, every member together, against the organization's daily allowance. */
  organization: AiUsageTotals & { dailyLimit: number };
  /** Today, the signed-in user here; `tokensEverywhere` (every organization they work in) is what their own allowance counts. */
  user: AiUsageTotals & { tokensEverywhere: number; dailyLimit: number };
  /** Today's organization usage by feature: every feature, in a fixed order. */
  features: (AiUsageTotals & { feature: AiFeature })[];
  /** The organization's usage on each of the last 30 UTC days, the oldest first and today last. */
  history: { date: string; tokens: number; calls: number }[];
}

export const aiUsageApi = {
  get: () => apiClient.get<AiUsage>("/ai-usage-totals"),
};
