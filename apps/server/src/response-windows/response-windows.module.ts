import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module.ts';
import { EscalationJob } from './escalation.job.ts';
import { EscalationScheduler } from './escalation.scheduler.ts';
import { ResponseWindowsController } from './response-windows.controller.ts';
import { ResponseWindowsService } from './response-windows.service.ts';

/** Response Windows and their escalation (ADR 0011, ticket 0055). */
@Module({
  imports: [InboxModule],
  controllers: [ResponseWindowsController],
  providers: [ResponseWindowsService, EscalationJob, EscalationScheduler],
  exports: [ResponseWindowsService, EscalationJob],
})
export class ResponseWindowsModule {}
