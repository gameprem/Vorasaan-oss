import { Module } from '@nestjs/common';
import { ResponseWindowsModule } from '../response-windows/response-windows.module.ts';
import { DecisionStatsController } from './decision-stats.controller.ts';
import { DecisionStatsService } from './decision-stats.service.ts';

/** Decision Lead Time per Project (ADR 0011, ticket 0056). */
@Module({
  imports: [ResponseWindowsModule],
  controllers: [DecisionStatsController],
  providers: [DecisionStatsService],
})
export class DecisionStatsModule {}
