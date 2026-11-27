import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AiUsageService } from './ai-usage.service';
import { OrgRole } from '../../common/authz/authz-policy';
import { AccessToken } from '../../common/decorators/access-token.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationContextGuard } from '../../common/guards/organization-context.guard';

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
