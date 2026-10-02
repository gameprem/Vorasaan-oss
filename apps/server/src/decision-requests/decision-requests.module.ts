import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { ResponseWindowsModule } from '../response-windows/response-windows.module.ts';
import { DecisionRequestsController } from './decision-requests.controller.ts';
import { DecisionRequestsService } from './decision-requests.service.ts';

/** Decision Requests and their state machine; exported so Action Cards send drafts through it. */
@Module({
  imports: [InboxModule, FeatureGuidelinesModule, ResponseWindowsModule],
  controllers: [DecisionRequestsController],
  providers: [DecisionRequestsService],
  exports: [DecisionRequestsService],
})
export class DecisionRequestsModule {}
