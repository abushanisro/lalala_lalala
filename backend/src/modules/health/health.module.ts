import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { CastingWorkerHealthIndicator } from './indicators/casting-worker.health';
import { EngineHealthIndicator } from './indicators/engine.health';
import { DatabaseModule } from '../../common/database/database.module';

@Module({
  imports: [TerminusModule, HttpModule, DatabaseModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, EngineHealthIndicator, CastingWorkerHealthIndicator],
})
export class HealthModule {}
