import { Module } from '@nestjs/common';
import { ConversationLocksModule } from '../conversations/conversation-locks.ts';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { GrillingController } from './grilling.controller.ts';
import { GrillingService } from './grilling.service.ts';
import { GrillingConversationsService } from './grilling-conversations.service.ts';

/**
 * Grilling a Project into a Brief Proposal (REQUIREMENT §3.8, ticket 0032), and
 * each holder's Grilling Conversations (0044), which ConversationsModule routes here.
 */
@Module({
  imports: [InboxModule, FeatureGuidelinesModule, ConversationLocksModule],
  controllers: [GrillingController],
  providers: [GrillingService, GrillingConversationsService],
  exports: [GrillingConversationsService],
})
export class GrillingModule {}
