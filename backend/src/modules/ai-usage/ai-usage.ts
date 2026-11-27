/**
 * The AI tokens an organization has spent, as the app shows them: today against the daily allowances, by feature, and day by day.
 *
 * Every figure is a sum of the usage the model's own responses reported (AiBudgetService records it after each call; migrations
 * 949 and 1166). Nothing is estimated. Days are UTC days, as the allowances are.
 *
 * Pure: no database access.
 */
import { AI_FEATURES, type AiFeature } from '../../common/ai/ai-budget.service';

export const AI_USAGE_HISTORY_DAYS = 30;

/** One row of ai_usage_summary(): an organization's usage on one UTC day in one feature, and the caller's own share of it. */
export interface AiUsageRow {
  usage_date: string;
  feature: string;
  organization_input_tokens: number | string;
  organization_output_tokens: number | string;
  organization_calls: number | string;
  user_input_tokens: number | string;
  user_output_tokens: number | string;
  user_calls: number | string;
}

/** `tokens` is input plus output; input includes what was written to and read from the prompt cache. */
export interface AiUsageTotals { tokens: number; inputTokens: number; outputTokens: number; calls: number }

export interface AiUsageSummary {
  /** The UTC day the daily figures are for, and the moment it ends and the allowances start again. */
  day: string;
  resetsAt: string;
  /** Today, every member of the organization together, against the organization's daily allowance. */
  organization: AiUsageTotals & { dailyLimit: number };
  /**
   * Today, the signed-in user in this organization. `tokensEverywhere` is what counts against the user's own daily allowance: their
   * tokens in every organization they work in.
   */
  user: AiUsageTotals & { tokensEverywhere: number; dailyLimit: number };
  /** Today's organization usage by feature: every feature, in a fixed order, zero when unused. */
  features: (AiUsageTotals & { feature: AiFeature })[];
  /** The organization's usage on each of the last AI_USAGE_HISTORY_DAYS UTC days, the oldest first and today last. */
  history: { date: string; tokens: number; calls: number }[];
}

const count = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const none = (): AiUsageTotals => ({ tokens: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
const add = (to: AiUsageTotals, input: number, output: number, calls: number): void => {
  to.inputTokens += input;
  to.outputTokens += output;
  to.tokens += input + output;
  to.calls += calls;
};
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export function summariseAiUsage(input: {
  rows: readonly AiUsageRow[];
  /** The user's tokens today in every organization (ai_usage_today), which is what the user's allowance counts. */
  userTokensEverywhere: number | string | null | undefined;
  limits: { userTokens: number; organizationTokens: number };
  now: Date;
}): AiUsageSummary {
  const day = utcDay(input.now);
  const midnight = Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate());
  const organization = none();
  const user = none();
  const byFeature = new Map<AiFeature, AiUsageTotals>(AI_FEATURES.map((feature) => [feature, none()]));
  const byDay = new Map<string, { tokens: number; calls: number }>();

  for (const row of input.rows) {
    const date = String(row.usage_date).slice(0, 10);
    const orgIn = count(row.organization_input_tokens), orgOut = count(row.organization_output_tokens), orgCalls = count(row.organization_calls);
    const dayTotal = byDay.get(date) ?? { tokens: 0, calls: 0 };
    dayTotal.tokens += orgIn + orgOut;
    dayTotal.calls += orgCalls;
    byDay.set(date, dayTotal);
    if (date !== day) continue;
    add(organization, orgIn, orgOut, orgCalls);
    add(user, count(row.user_input_tokens), count(row.user_output_tokens), count(row.user_calls));
    // A feature this server does not know (a newer backend wrote it) is still spend: it is shown with the unnamed usage.
    const feature = (AI_FEATURES as readonly string[]).includes(row.feature) ? (row.feature as AiFeature) : 'other';
    const totals = byFeature.get(feature);
    if (totals) add(totals, orgIn, orgOut, orgCalls);
  }

  const history = Array.from({ length: AI_USAGE_HISTORY_DAYS }, (_, i) => {
    const date = utcDay(new Date(midnight - (AI_USAGE_HISTORY_DAYS - 1 - i) * 86_400_000));
    return { date, ...(byDay.get(date) ?? { tokens: 0, calls: 0 }) };
  });

  return {
    day,
    resetsAt: new Date(midnight + 86_400_000).toISOString(),
    organization: { ...organization, dailyLimit: input.limits.organizationTokens },
    user: { ...user, tokensEverywhere: Math.max(count(input.userTokensEverywhere), user.tokens), dailyLimit: input.limits.userTokens },
    features: AI_FEATURES.map((feature) => ({ feature, ...(byFeature.get(feature) ?? none()) })),
    history,
  };
}
