import { Module } from '@nestjs/common';

import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';
import { DatabaseModule } from '../../common/database/database.module';

/** AiBudgetService (the daily allowances) comes from the global AiModule. */
@Module({
  imports: [DatabaseModule],
  controllers: [AiUsageController],
  providers: [AiUsageService],
})
export class AiUsageModule {}
