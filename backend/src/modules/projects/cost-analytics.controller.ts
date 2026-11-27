import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CostAnalyticsService } from './cost-analytics.service';
import { OrgRole } from '../../common/authz/authz-policy';
import { AccessToken } from '../../common/decorators/access-token.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { OrganizationContextGuard } from '../../common/guards/organization-context.guard';

import type { CostAnalytics } from './cost-analytics';

/** The organization's should-cost in figures the dashboard charts. Read-only: it totals saved cost records and recalculates nothing. */
@ApiTags('Cost analytics')
@ApiBearerAuth()
@OrgRole('viewer')
@Controller({ path: 'cost-analytics', version: '1' })
export class CostAnalyticsController {
  constructor(private readonly analytics: CostAnalyticsService) {}

  @Get()
  @UseGuards(OrganizationContextGuard)
  @ApiOperation({ summary: "The organization's should-cost: coverage, cost elements and drivers, annual spend, parts, processes, machines, materials, BOMs, and the gap to each part's ask price." })
  async summary(@CurrentOrganization() organizationId: string, @AccessToken() token: string): Promise<CostAnalytics> {
    return this.analytics.summary(organizationId, token);
  }
}
