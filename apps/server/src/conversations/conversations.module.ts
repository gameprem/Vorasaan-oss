import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { ConversationsController } from './conversations.controller.ts';
import { ConversationsService } from './conversations.service.ts';

/** A person's Conversations with the AI, streamed over `GET /events` (ADR 0008, ticket 0042). */
@Module({
  imports: [InboxModule, FeatureGuidelinesModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
