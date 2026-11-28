import Anthropic from '@anthropic-ai/sdk';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { accountRanges, accountTotals, monthlyLimitUsd, usdFromCents, type AiAccount, type AiAccountTotals } from './ai-account';

/** Anthropic's reports change a few times an hour at most, and it asks for about one read a minute: one reading serves everyone this long. */
const KEEP_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

async function all<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const read: T[] = [];
  for await (const row of rows) read.push(row);
  return read;
}

/**
 * Reads the Anthropic account's spend and usage from Anthropic's own reports, with the Admin API key (ANTHROPIC_ADMIN_API_KEY). That
 * key is not the one models are called with: it reads the organization's reports, and stays in this service. With no key the answer
 * is `configured: false` and nothing is asked of Anthropic.
 */
@Injectable()
export class AiAccountService {
  private readonly logger = new Logger(AiAccountService.name);
  private readonly client: Anthropic | null;
  /** The limit typed into the server's settings, for an account whose spend limits Anthropic does not report. */
  private readonly settingLimitUsd: number | null;
  private limitsReported = true;
  private kept: { until: number; totals: AiAccountTotals } | null = null;
  private reading: Promise<AiAccountTotals> | null = null;

  constructor(config: ConfigService) {
    const key = config.get<string>('ANTHROPIC_ADMIN_API_KEY');
    this.client = key ? new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;
    const limit = Number(config.get<string | number>('ANTHROPIC_MONTHLY_SPEND_LIMIT_USD'));
    this.settingLimitUsd = Number.isFinite(limit) && limit > 0 ? limit : null;
  }

  async read(now: Date = new Date()): Promise<AiAccount> {
    const client = this.client;
    if (!client) return { configured: false };
    if (this.kept && this.kept.until > now.getTime()) return { configured: true, ...this.kept.totals };
    // One reading at a time: everyone who asks while it is under way gets the same one.
    this.reading ??= this.report(client, now).finally(() => { this.reading = null; });
    const totals = await this.reading;
    this.kept = { until: now.getTime() + KEEP_MS, totals };
    return { configured: true, ...totals };
  }

  private async report(client: Anthropic, now: Date): Promise<AiAccountTotals> {
    const { analytics } = client.beta.organization;
    const ranges = accountRanges(now);
    try {
      const [month, weekUsage, weekCost, limitUsd] = await Promise.all([
        // The month so far as one row. In its first hour there is no whole hour to report yet, and the reports refuse an empty range.
        now.getTime() - Date.parse(ranges.monthStart) < HOUR_MS ? null : analytics.cost.list({ starting_at: ranges.monthStart }),
        all(analytics.usage.list({ starting_at: ranges.weekStart, group_by: ['model'], limit: 1000 })),
        all(analytics.cost.list({ starting_at: ranges.weekStart, group_by: ['model'], limit: 1000 })),
        this.limitUsd(client),
      ]);
      return accountTotals({ now, monthSpendUsd: usdFromCents(month?.data[0]?.cost.amount), asOf: month?.data_refreshed_at ?? null, limitUsd, weekUsage, weekCost });
    } catch (error) {
      const status = error instanceof Anthropic.APIError && typeof error.status === 'number' ? ` (HTTP ${error.status})` : '';
      this.logger.warn(`Anthropic account reports not read${status}: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadGatewayException({ code: 'AI_ACCOUNT_UNAVAILABLE', message: `Anthropic did not give the account's usage and cost reports${status}. Check the Admin API key.` });
    }
  }

  /** The limit Anthropic reports for the organization; for an account it reports none for (the spend limit API is not open to every account), the setting. */
  private async limitUsd(client: Anthropic): Promise<number | null> {
    if (this.limitsReported) {
      try {
        const reported = monthlyLimitUsd(await all(client.beta.organization.spendLimits.list({ scope_type: ['organization'] })));
        if (reported !== null) return reported;
      } catch (error) {
        this.limitsReported = false;                  // not asked again until the server restarts
        this.logger.log(`Anthropic reports no spend limits for this account (${error instanceof Error ? error.message : String(error)}): using ANTHROPIC_MONTHLY_SPEND_LIMIT_USD`);
      }
    }
    return this.settingLimitUsd;
  }
}
