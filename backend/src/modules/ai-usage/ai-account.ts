/**
 * The Anthropic account's own figures, as the Claude Console shows them: what was spent this calendar month against the account's
 * spend limit, and the last seven days' tokens by model. They come from Anthropic's usage and cost reports (read with an Admin API
 * key), not from the app's own counts: they cover everything the account's keys spent, every customer together, and Anthropic's
 * data runs behind by half an hour to a few hours (`asOf` says how far it is complete).
 *
 * Pure: no network, no database. The rows are Anthropic's, typed here only as far as they are read.
 */

export interface CostRow { cost: { amount: string }; group: { model: string | null } }
export interface UsageRow {
  usage: {
    total_tokens: number; uncached_input_tokens: number; cache_read_input_tokens: number; output_tokens: number; requests: number | null;
    cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
  };
  group: { model: string | null };
}
export interface LimitRow { amount: string | null; currency: string; is_enabled: boolean; period: string; scope: { type: string } }

export interface AiAccountModel { model: string; tokens: number; requests: number; spendUsd: number }
export interface AiAccountTotals {
  /** The moment Anthropic's data is complete up to; null when it does not say. */
  asOf: string | null;
  /** The calendar month so far (UTC). `limitUsd` is the account's monthly spend limit, null when none is known. */
  month: { startsAt: string; resetsAt: string; spendUsd: number; limitUsd: number | null };
  /** The last seven days, to the hour. Input tokens are in three parts: not cached, read from the cache, written to it. */
  week: {
    startsAt: string; tokens: number; uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number;
    requests: number; spendUsd: number; models: AiAccountModel[];
  };
}
/** `configured: false`: the server has no Admin API key, so there is nothing to read. */
export type AiAccount = { configured: false } | ({ configured: true } & AiAccountTotals);

const HOUR_MS = 3_600_000;
/** What a row with no model is listed as (code execution, and usage Anthropic attributes to no model). */
export const NO_MODEL = 'Other';

/** The periods the figures are for: the UTC calendar month `now` is in, and the seven days up to `now`, to the hour (the reports' own grain). */
export function accountRanges(now: Date): { monthStart: string; resetsAt: string; weekStart: string } {
  const year = now.getUTCFullYear(), month = now.getUTCMonth();
  return {
    monthStart: new Date(Date.UTC(year, month, 1)).toISOString(),
    resetsAt: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
    weekStart: new Date(Math.floor((now.getTime() - 7 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS).toISOString(),
  };
}

/** Money as Anthropic's reports give it (a decimal string of cents, with fractions) in dollars. Anything unreadable is 0. */
export function usdFromCents(amount: string | null | undefined): number {
  const cents = Number(amount ?? '');
  return Number.isFinite(cents) ? cents / 100 : 0;
}

/** The account's monthly limit in dollars, from its spend limits: the organization's own, in force and in USD. Null when there is none. */
export function monthlyLimitUsd(limits: readonly LimitRow[]): number | null {
  const limit = limits.find(l => l.scope.type === 'organization' && l.period === 'monthly' && l.is_enabled && l.amount !== null && l.currency === 'USD');
  return limit ? usdFromCents(limit.amount) : null;
}

/** The figures from the reports' rows: the month's spend, and the week's tokens and spend, in all and for each model (dearest first). */
export function accountTotals(input: {
  now: Date; monthSpendUsd: number; asOf: string | null; limitUsd: number | null; weekUsage: readonly UsageRow[]; weekCost: readonly CostRow[];
}): AiAccountTotals {
  const ranges = accountRanges(input.now);
  const models = new Map<string, AiAccountModel>();
  const of = (name: string | null): AiAccountModel => {
    const model = name ?? NO_MODEL;
    let entry = models.get(model);
    if (!entry) { entry = { model, tokens: 0, requests: 0, spendUsd: 0 }; models.set(model, entry); }
    return entry;
  };
  const week = { tokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, requests: 0, spendUsd: 0 };
  for (const { usage, group } of input.weekUsage) {
    const model = of(group.model);
    model.tokens += usage.total_tokens;
    model.requests += usage.requests ?? 0;
    week.tokens += usage.total_tokens;
    week.uncachedInputTokens += usage.uncached_input_tokens;
    week.cacheReadTokens += usage.cache_read_input_tokens;
    week.cacheWriteTokens += usage.cache_creation.ephemeral_1h_input_tokens + usage.cache_creation.ephemeral_5m_input_tokens;
    week.outputTokens += usage.output_tokens;
    week.requests += usage.requests ?? 0;
  }
  for (const { cost, group } of input.weekCost) {
    const spend = usdFromCents(cost.amount);
    of(group.model).spendUsd += spend;
    week.spendUsd += spend;
  }
  return {
    asOf: input.asOf,
    month: { startsAt: ranges.monthStart, resetsAt: ranges.resetsAt, spendUsd: input.monthSpendUsd, limitUsd: input.limitUsd },
    week: { startsAt: ranges.weekStart, ...week, models: [...models.values()].sort((a, b) => b.spendUsd - a.spendUsd || b.tokens - a.tokens || a.model.localeCompare(b.model)) },
  };
}
