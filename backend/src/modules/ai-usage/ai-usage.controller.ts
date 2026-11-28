import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AiAccountService } from './ai-account.service';
import { AiUsageService } from './ai-usage.service';
import { Authenticated, OrgRole } from '../../common/authz/authz-policy';
import { AccessToken } from '../../common/decorators/access-token.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationContextGuard } from '../../common/guards/organization-context.guard';

import type { AiAccount } from './ai-account';
import type { AiUsageSummary } from './ai-usage';

/** The AI tokens the organization has spent, from the usage each model response reported. Read-only: it spends no AI itself. */
@ApiTags('AI usage')
@ApiBearerAuth()
@OrgRole('viewer')
@Controller({ path: 'ai-usage-totals', version: '1' })
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get()
  @UseGuards(OrganizationContextGuard)
  @ApiOperation({ summary: "The organization's AI tokens today against the daily allowances, by feature, and for each of the last 30 days." })
  async summary(
    @CurrentUser() user: { id: string },
    @CurrentOrganization() organizationId: string,
    @AccessToken() token: string,
  ): Promise<AiUsageSummary> {
    return this.usage.summary({ userId: user.id, organizationId, accessToken: token });
  }
}

/**
 * The Anthropic account's own spend and usage, as the Claude Console shows them: the platform's bill, every organization together.
 * Shown to every signed-in person (owner's decision, 2026-11-28), so it belongs to no organization and needs none. Read-only: it
 * spends no AI itself, and the Admin API key it is read with never leaves the server.
 */
@ApiTags('AI usage')
@ApiBearerAuth()
@Controller({ path: 'ai-account-totals', version: '1' })
export class AiAccountController {
  constructor(private readonly account: AiAccountService) {}

  @Authenticated()
  @Get()
  @ApiOperation({ summary: "The Anthropic account's spend this month against its limit, and the last seven days' tokens by model, from Anthropic's own reports." })
  totals(): Promise<AiAccount> {
    return this.account.read();
  }
}
