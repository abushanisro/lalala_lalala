import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { AI_USAGE_HISTORY_DAYS, summariseAiUsage, type AiUsageRow, type AiUsageSummary } from './ai-usage';
import { AiBudgetService, type AiCaller } from '../../common/ai/ai-budget.service';
import { DatabaseService } from '../../common/database/database.service';

/** Reads the AI usage the budget service recorded, as the signed-in user (migration 1166's functions), and sums it for the app. It reads only. */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly database: DatabaseService, private readonly budget: AiBudgetService) {}

  async summary(caller: AiCaller, now: Date = new Date()): Promise<AiUsageSummary> {
    const client = this.database.getUserClient(caller.accessToken);
    const [byDay, today] = await Promise.all([
      client.rpc('ai_usage_summary', { p_organization_id: caller.organizationId, p_days: AI_USAGE_HISTORY_DAYS }),
      client.rpc('ai_usage_today', { p_organization_id: caller.organizationId }),
    ]);
    const error = byDay.error ?? today.error;
    if (error) {
      if (error.code === '42501') throw new ForbiddenException('You are not a member of this organization.');
      this.logger.error(`AI usage read failed user=${caller.userId} org=${caller.organizationId}: ${error.message}`);
      throw new ServiceUnavailableException({ message: 'AI usage could not be read. Try again shortly.', code: 'AI_USAGE_UNAVAILABLE' });
    }
    const totals = (Array.isArray(today.data) ? today.data[0] : today.data) as { user_tokens?: number | string } | null | undefined;
    return summariseAiUsage({
      rows: (byDay.data ?? []) as AiUsageRow[],
      userTokensEverywhere: totals?.user_tokens,
      limits: this.budget.dailyLimits(),
      now,
    });
  }
}
