import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';

import { AI_USAGE_HISTORY_DAYS, summariseAiUsage, type AiUsageRow } from '../../../modules/ai-usage/ai-usage';
import { AiUsageService } from '../../../modules/ai-usage/ai-usage.service';
import { AI_TEST_LIMITS, aiBudget, fakeAnthropic } from '../../support/ai-fakes';
import { fakeClient, type Result } from '../../support/fake-db-client';
import type { DatabaseService } from '../../../common/database/database.service';

const NOW = new Date('2026-11-28T09:30:00Z');
const limits = { userTokens: 2_000_000, organizationTokens: 20_000_000 };
const row = (usage_date: string, feature: string, org: [number, number, number], user: [number, number, number] = [0, 0, 0]): AiUsageRow => ({
  usage_date, feature,
  organization_input_tokens: org[0], organization_output_tokens: org[1], organization_calls: org[2],
  user_input_tokens: user[0], user_output_tokens: user[1], user_calls: user[2],
});

describe('summariseAiUsage', () => {
  const rows = [
    row('2026-11-27', 'other', [4921, 1183, 1]),
    row('2026-11-28', 'copilot', [3300, 350, 3], [2000, 100, 1]),
    row('2026-11-28', 'drawing_reading', [4000, 600, 1]),
    row('2026-11-28', 'vave', [500, 50, 1], [500, 50, 1]),
  ];

  it('totals today for the organization and for the user, against the daily allowances', () => {
    const out = summariseAiUsage({ rows, userTokensEverywhere: 9000, limits, now: NOW });
    expect(out.day).toBe('2026-11-28');
    expect(out.resetsAt).toBe('2026-11-29T00:00:00.000Z');
    expect(out.organization).toEqual({ tokens: 8800, inputTokens: 7800, outputTokens: 1000, calls: 5, dailyLimit: 20_000_000 });
    expect(out.user).toEqual({ tokens: 2650, inputTokens: 2500, outputTokens: 150, calls: 2, tokensEverywhere: 9000, dailyLimit: 2_000_000 });
  });

  it('lists every feature in a fixed order, zero when unused, and adds up to the organization total', () => {
    const out = summariseAiUsage({ rows, userTokensEverywhere: 0, limits, now: NOW });
    expect(out.features.map((f) => [f.feature, f.tokens, f.calls])).toEqual([['copilot', 3650, 3], ['drawing_reading', 4600, 1], ['vave', 550, 1], ['other', 0, 0]]);
    expect(out.features.reduce((sum, f) => sum + f.tokens, 0)).toBe(out.organization.tokens);
  });

  it('shows a feature it does not know with the unnamed usage, so no spend is left out', () => {
    const out = summariseAiUsage({ rows: [row('2026-11-28', 'meeting_notes', [100, 20, 1]), row('2026-11-28', 'other', [10, 5, 1])], userTokensEverywhere: 0, limits, now: NOW });
    expect(out.features.find((f) => f.feature === 'other')).toMatchObject({ tokens: 135, calls: 2 });
    expect(out.organization.tokens).toBe(135);
  });

  it('gives each of the last 30 UTC days, the oldest first and today last, with zero for a day nothing was spent', () => {
    const out = summariseAiUsage({ rows, userTokensEverywhere: 0, limits, now: NOW });
    expect(out.history).toHaveLength(AI_USAGE_HISTORY_DAYS);
    expect(out.history[0]).toEqual({ date: '2026-10-30', tokens: 0, calls: 0 });
    expect(out.history.slice(-2)).toEqual([{ date: '2026-11-27', tokens: 6104, calls: 1 }, { date: '2026-11-28', tokens: 8800, calls: 5 }]);
  });

  it('reads the counters as the database sends them (big numbers arrive as text), and is all zero for no usage', () => {
    const text = { ...row('2026-11-28', 'copilot', [0, 0, 0]), organization_input_tokens: '12000000000', organization_output_tokens: '5', organization_calls: '7' };
    expect(summariseAiUsage({ rows: [text], userTokensEverywhere: '42', limits, now: NOW }).organization).toMatchObject({ tokens: 12_000_000_005, calls: 7 });
    const none = summariseAiUsage({ rows: [], userTokensEverywhere: null, limits, now: NOW });
    expect(none.organization.tokens).toBe(0);
    expect(none.user.tokensEverywhere).toBe(0);
    expect(none.features.every((f) => f.tokens === 0)).toBe(true);
  });

  it('never shows the user less everywhere than in this organization alone', () => {
    expect(summariseAiUsage({ rows, userTokensEverywhere: 10, limits, now: NOW }).user.tokensEverywhere).toBe(2650);
  });
});

describe('AiUsageService', () => {
  const caller = { userId: 'user-1', organizationId: 'org-1', accessToken: 'token' };
  const service = (rpc: (fn: string, args: unknown) => Result) => {
    const db = fakeClient(() => ({ data: null, error: null }), rpc);
    const database = { getUserClient: () => db.client } as unknown as DatabaseService;
    return { db, usage: new AiUsageService(database, aiBudget(database, fakeAnthropic([]).client)) };
  };

  it('reads the summary and today as the signed-in user, for the organization the request acts for', async () => {
    const { db, usage } = service((fn) => (fn === 'ai_usage_summary'
      ? { data: [row('2026-11-28', 'copilot', [100, 10, 1], [100, 10, 1])], error: null }
      : { data: [{ user_tokens: 500, organization_tokens: 110, global_tokens: 900 }], error: null }));
    const out = await usage.summary(caller, NOW);
    expect(db.rpcCalls).toEqual(expect.arrayContaining([
      { fn: 'ai_usage_summary', args: { p_organization_id: 'org-1', p_days: 30 } },
      { fn: 'ai_usage_today', args: { p_organization_id: 'org-1' } },
    ]));
    expect(out.organization).toMatchObject({ tokens: 110, dailyLimit: AI_TEST_LIMITS.AI_ORG_DAILY_TOKENS });
    expect(out.user).toMatchObject({ tokens: 110, tokensEverywhere: 500, dailyLimit: AI_TEST_LIMITS.AI_USER_DAILY_TOKENS });
  });

  it('answers 403 to someone who is not a member, and 503 when the usage cannot be read', async () => {
    const refused = service(() => ({ data: null, error: { code: '42501', message: 'not a member of organization org-1' } }));
    await expect(refused.usage.summary(caller, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    const down = service((fn) => (fn === 'ai_usage_today' ? { data: null, error: { code: '57P01', message: 'down' } } : { data: [], error: null }));
    await expect(down.usage.summary(caller, NOW)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
