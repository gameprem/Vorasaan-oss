import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { FeatureSuggestionsController } from './feature-suggestions.controller.ts';
import { FeatureSuggestionsService } from './feature-suggestions.service.ts';

/** Feature Suggestions and the Feature Guidelines fit check (REQUIREMENT §3.8, ticket 0034). */
@Module({
  imports: [InboxModule, FeatureGuidelinesModule],
  controllers: [FeatureSuggestionsController],
  providers: [FeatureSuggestionsService],
  exports: [FeatureSuggestionsService],
})
export class FeatureSuggestionsModule {}
