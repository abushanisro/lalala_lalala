import { Module } from '@nestjs/common';

import { AiAccountService } from './ai-account.service';
import { AiAccountController, AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';
import { DatabaseModule } from '../../common/database/database.module';

/** AiBudgetService (the daily allowances) comes from the global AiModule. */
@Module({
  imports: [DatabaseModule],
  controllers: [AiUsageController, AiAccountController],
  providers: [AiUsageService, AiAccountService],
})
export class AiUsageModule {}
