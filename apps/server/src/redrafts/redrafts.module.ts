import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { RedraftsController } from './redrafts.controller.ts';
import { RedraftsService } from './redrafts.service.ts';

/**
 * Request changes and Redrafts of every AI proposal (ADR 0013, ticket 0065). Exported so
 * Action Cards and chat app presses Request changes through the same service.
 */
@Module({
  imports: [InboxModule, FeatureGuidelinesModule],
  controllers: [RedraftsController],
  providers: [RedraftsService],
  exports: [RedraftsService],
})
export class RedraftsModule {}
