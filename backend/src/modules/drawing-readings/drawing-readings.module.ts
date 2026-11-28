import { Module } from '@nestjs/common';

import { DrawingReadingsController, DrawingSolidsController, IntakeAnswersController, IntakePicksController } from './drawing-readings.controller';
import { DrawingReadingsService } from './drawing-readings.service';
import { DrawingSolidsService } from './drawing-solids.service';
import { IntakeAnswersService } from './intake-answers.service';
import { IntakePicksService } from './intake-picks.service';
import { DatabaseModule } from '../../common/database/database.module';

/** AiBudgetService comes from the global AiModule; the organization guard reads memberships through DatabaseModule. */
@Module({
  imports: [DatabaseModule],
  controllers: [DrawingReadingsController, DrawingSolidsController, IntakeAnswersController, IntakePicksController],
  providers: [DrawingReadingsService, DrawingSolidsService, IntakeAnswersService, IntakePicksService],
})
export class DrawingReadingsModule {}
