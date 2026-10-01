import { Module } from '@nestjs/common';
import { ActionCardsController } from '../action-cards/action-cards.controller.ts';
import { ActionCardsService } from '../action-cards/action-cards.service.ts';
import { BriefModule } from '../brief/brief.module.ts';
import { DecisionRequestsModule } from '../decision-requests/decision-requests.module.ts';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { FeatureSuggestionsModule } from '../feature-suggestions/feature-suggestions.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { SpecModule } from '../spec/spec.module.ts';
import { ConversationsController } from './conversations.controller.ts';
import { ConversationsService } from './conversations.service.ts';

/**
 * A person's Conversations with the AI, streamed over `GET /events` (ADR 0008,
 * ticket 0042), and the Action Cards its tools make (0043), approved through
 * the Decision Request, Spec, Brief and Feature Suggestion services.
 */
@Module({
  imports: [
    InboxModule,
    FeatureGuidelinesModule,
    DecisionRequestsModule,
    SpecModule,
    BriefModule,
    FeatureSuggestionsModule,
  ],
  controllers: [ConversationsController, ActionCardsController],
  providers: [ConversationsService, ActionCardsService],
})
export class ConversationsModule {}
