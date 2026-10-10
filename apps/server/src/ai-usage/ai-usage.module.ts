import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module.ts';
import { AiUsageController } from './ai-usage.controller.ts';
import { AiUsageService } from './ai-usage.service.ts';

/** The AI usage dashboard and the monthly AI budget (ticket 0075). */
@Module({
  imports: [InboxModule],
  controllers: [AiUsageController],
  providers: [AiUsageService],
})
export class AiUsageModule {}
