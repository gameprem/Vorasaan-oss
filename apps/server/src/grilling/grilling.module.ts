import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { GrillingController } from './grilling.controller.ts';
import { GrillingService } from './grilling.service.ts';

/** Grilling a Project into a Brief Proposal (REQUIREMENT §3.8, ticket 0032). */
@Module({
  imports: [InboxModule, FeatureGuidelinesModule],
  controllers: [GrillingController],
  providers: [GrillingService],
})
export class GrillingModule {}
