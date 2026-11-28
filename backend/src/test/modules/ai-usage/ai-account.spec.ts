import { BadGatewayException } from '@nestjs/common';

import { NO_MODEL, accountRanges, accountTotals, monthlyLimitUsd, usdFromCents, type CostRow, type LimitRow, type UsageRow } from '../../../modules/ai-usage/ai-account';
import { AiAccountService } from '../../../modules/ai-usage/ai-account.service';

import type { ConfigService } from '@nestjs/config';

const NOW = new Date('2026-11-28T09:40:00Z');
const usage = (model: string | null, total: number, parts: { uncached?: number; read?: number; write5m?: number; write1h?: number; output?: number; requests?: number | null } = {}): UsageRow => ({
  group: { model },
  usage: {
    total_tokens: total, uncached_input_tokens: parts.uncached ?? 0, cache_read_input_tokens: parts.read ?? 0, output_tokens: parts.output ?? 0,
    requests: parts.requests === undefined ? 1 : parts.requests, cache_creation: { ephemeral_5m_input_tokens: parts.write5m ?? 0, ephemeral_1h_input_tokens: parts.write1h ?? 0 },
  },
});
const cost = (model: string | null, cents: string): CostRow => ({ group: { model }, cost: { amount: cents } });
const limit = (over: Partial<LimitRow> = {}): LimitRow => ({ amount: '2000', currency: 'USD', is_enabled: true, period: 'monthly', scope: { type: 'organization' }, ...over });

describe('the periods and the money', () => {
  it('reports the UTC calendar month, its reset, and the seven days up to the hour', () => {
    expect(accountRanges(NOW)).toEqual({ monthStart: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', weekStart: '2026-11-21T09:00:00.000Z' });
    expect(accountRanges(new Date('2026-12-31T23:59:59Z'))).toMatchObject({ monthStart: '2026-12-01T00:00:00.000Z', resetsAt: '2027-01-01T00:00:00.000Z' });
  });

  it('reads fractional cents as dollars, and anything else as nothing', () => {
    expect(usdFromCents('351.25')).toBeCloseTo(3.5125, 6);
    expect(usdFromCents('2000')).toBe(20);
    for (const bad of [null, undefined, '', 'n/a']) expect(usdFromCents(bad)).toBe(0);
  });

  it("takes the organization's own monthly limit that is in force, and no other", () => {
    expect(monthlyLimitUsd([limit({ scope: { type: 'workspace' }, amount: '500' }), limit()])).toBe(20);
    for (const other of [limit({ period: 'daily' }), limit({ is_enabled: false }), limit({ amount: null }), limit({ currency: 'EUR' }), limit({ scope: { type: 'workspace' } })]) expect(monthlyLimitUsd([other])).toBeNull();
    expect(monthlyLimitUsd([])).toBeNull();
  });
});

describe('the figures from the reports', () => {
  it('adds the week up in all and for each model, the dearest first, and keeps the month and its limit', () => {
    const totals = accountTotals({
      now: NOW, monthSpendUsd: 3.51, asOf: '2026-11-28T08:00:00Z', limitUsd: 20,
      weekUsage: [
        usage('claude-sonnet-5-5', 900_000, { uncached: 300_000, read: 500_000, write5m: 40_000, write1h: 10_000, output: 50_000, requests: 120 }),
        usage('claude-opus-5-5', 400_000, { uncached: 350_000, output: 50_000, requests: 30 }),
        usage(null, 0, { requests: null }),
      ],
      weekCost: [cost('claude-sonnet-5-5', '95.5'), cost('claude-opus-5-5', '210'), cost(null, '1.5')],
    });
    expect(totals.asOf).toBe('2026-11-28T08:00:00Z');
    expect(totals.month).toEqual({ startsAt: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', spendUsd: 3.51, limitUsd: 20 });
    expect(totals.week).toMatchObject({ startsAt: '2026-11-21T09:00:00.000Z', tokens: 1_300_000, uncachedInputTokens: 650_000, cacheReadTokens: 500_000, cacheWriteTokens: 50_000, outputTokens: 100_000, requests: 150 });
    expect(totals.week.spendUsd).toBeCloseTo(3.07, 6);
    expect(totals.week.models.map(m => m.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', NO_MODEL]);
    expect(totals.week.models[0]).toEqual({ model: 'claude-opus-5-5', tokens: 400_000, requests: 30, spendUsd: 2.1 });
  });

  it('is zeros for an account with nothing in its reports', () => {
    expect(accountTotals({ now: NOW, monthSpendUsd: 0, asOf: null, limitUsd: null, weekUsage: [], weekCost: [] })).toMatchObject({
      asOf: null, month: { spendUsd: 0, limitUsd: null }, week: { tokens: 0, requests: 0, spendUsd: 0, models: [] },
    });
  });
});

describe('AiAccountService', () => {
  const config = (values: Record<string, string>) => ({ get: (name: string) => values[name] }) as unknown as ConfigService;
  /** A page of the reports: awaited it is the first page, iterated it is every row. */
  const page = <T>(rows: T[], refreshed: string | null = '2026-11-28T08:00:00Z') => Object.assign(Promise.resolve({ data: rows, data_refreshed_at: refreshed }), {
    async *[Symbol.asyncIterator]() { yield* await Promise.resolve(rows); },
  });
  interface Calls { cost: jest.Mock; usage: jest.Mock; limits: jest.Mock }
  /** The service with Anthropic's client replaced by one that answers from these rows. */
  function service(values: Record<string, string>, calls: Calls): AiAccountService {
    const account = new AiAccountService(config(values));
    if (values.ANTHROPIC_ADMIN_API_KEY) {
      (account as unknown as { client: unknown }).client = { beta: { organization: { analytics: { cost: { list: calls.cost }, usage: { list: calls.usage } }, spendLimits: { list: calls.limits } } } };
    }
    return account;
  }
  const answering = (over: Partial<Calls> = {}): Calls => ({
    cost: jest.fn((params: { group_by?: string[] }) => (params.group_by ? page([cost('claude-sonnet-5-5', '95.5')]) : page([cost(null, '351')]))),
    usage: jest.fn(() => page([usage('claude-sonnet-5-5', 900_000, { read: 500_000, requests: 120 })])),
    limits: jest.fn(() => page([limit()])),
    ...over,
  });

  it('asks nothing of Anthropic and says so when the server has no Admin API key', async () => {
    const calls = answering();
    expect(await service({}, calls).read(NOW)).toEqual({ configured: false });
    expect(calls.cost).not.toHaveBeenCalled();
  });

  it("reads the month's spend, the week by model and the limit, and keeps the reading for five minutes", async () => {
    const calls = answering();
    const account = service({ ANTHROPIC_ADMIN_API_KEY: 'admin-key' }, calls);
    const read = await account.read(NOW);
    expect(read).toMatchObject({ configured: true, asOf: '2026-11-28T08:00:00Z', month: { spendUsd: 3.51, limitUsd: 20 }, week: { tokens: 900_000, cacheReadTokens: 500_000, requests: 120 } });
    expect(calls.cost).toHaveBeenCalledWith({ starting_at: '2026-11-01T00:00:00.000Z' });
    expect(calls.cost).toHaveBeenCalledWith({ starting_at: '2026-11-21T09:00:00.000Z', group_by: ['model'], limit: 1000 });
    expect(calls.usage).toHaveBeenCalledWith({ starting_at: '2026-11-21T09:00:00.000Z', group_by: ['model'], limit: 1000 });
    expect(calls.limits).toHaveBeenCalledWith({ scope_type: ['organization'] });

    await account.read(new Date(NOW.getTime() + 4 * 60_000));
    expect(calls.usage).toHaveBeenCalledTimes(1);
    await account.read(new Date(NOW.getTime() + 6 * 60_000));
    expect(calls.usage).toHaveBeenCalledTimes(2);
  });

  it('gives everyone who asks at once the same reading', async () => {
    const calls = answering();
    const account = service({ ANTHROPIC_ADMIN_API_KEY: 'admin-key' }, calls);
    await Promise.all([account.read(NOW), account.read(NOW), account.read(NOW)]);
    expect(calls.usage).toHaveBeenCalledTimes(1);
  });

  it('uses the limit from the settings for an account Anthropic reports no limits for, and does not ask again', async () => {
    const calls = answering({ limits: jest.fn(() => { throw new Error('spend limits are not available to this organization'); }) });
    const account = service({ ANTHROPIC_ADMIN_API_KEY: 'admin-key', ANTHROPIC_MONTHLY_SPEND_LIMIT_USD: '20' }, calls);
    expect(await account.read(NOW)).toMatchObject({ month: { limitUsd: 20 } });
    await account.read(new Date(NOW.getTime() + 6 * 60_000));
    expect(calls.limits).toHaveBeenCalledTimes(1);
    const none = service({ ANTHROPIC_ADMIN_API_KEY: 'admin-key' }, answering({ limits: jest.fn(() => page([])) }));
    expect(await none.read(NOW)).toMatchObject({ month: { limitUsd: null } });
  });

  it("does not ask for the month in its first hour, when there is no whole hour to report", async () => {
    const calls = answering();
    const read = await service({ ANTHROPIC_ADMIN_API_KEY: 'admin-key' }, calls).read(new Date('2026-12-01T00:20:00Z'));
    expect(read).toMatchObject({ configured: true, asOf: null, month: { spendUsd: 0, startsAt: '2026-12-01T00:00:00.000Z' } });
    expect(calls.cost).toHaveBeenCalledTimes(1);      // the week by model only
  });

  it('says the reports could not be read, without the key, when Anthropic refuses', async () => {
    const calls = answering({ usage: jest.fn(() => { throw new Error('invalid x-api-key'); }) });
    const account = service({ ANTHROPIC_ADMIN_API_KEY: 'admin-key' }, calls);
    const refused = await account.read(NOW).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify((refused as BadGatewayException).getResponse())).not.toContain('admin-key');
    expect(JSON.stringify((refused as BadGatewayException).getResponse())).toMatch(/Check the Admin API key/);
    await expect(account.read(NOW)).rejects.toBeInstanceOf(BadGatewayException);   // a failure is not kept: it is asked again
    expect(calls.usage).toHaveBeenCalledTimes(2);
  });
});
