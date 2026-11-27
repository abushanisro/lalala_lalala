import { Module } from '@nestjs/common';
import { CostAnalyticsController } from './cost-analytics.controller';
import { CostAnalyticsService } from './cost-analytics.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectsRepository } from './projects.repository';
import { LoggerModule } from '../../common/logger/logger.module';
import { DatabaseService } from '../../common/database/database.service';
import { ExchangeRateModule } from '../../common/exchange-rate/exchange-rate.module';

@Module({
  imports: [
    LoggerModule,
    ExchangeRateModule,
  ],
  controllers: [ProjectsController, CostAnalyticsController],
  providers: [ProjectsService, ProjectsRepository, DatabaseService, CostAnalyticsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
