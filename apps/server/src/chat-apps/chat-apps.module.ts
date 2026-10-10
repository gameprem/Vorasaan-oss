import { Module } from '@nestjs/common';
import { DecisionRequestsModule } from '../decision-requests/decision-requests.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { RedraftsModule } from '../redrafts/redrafts.module.ts';
import { OpenIdKeySource, TEAMS_KEY_SOURCE } from './adapters/teams-keys.ts';
import { ChatAccountsService } from './chat-accounts.service.ts';
import { ChatActionsService } from './chat-actions.service.ts';
import { ChatAdapters } from './chat-adapters.ts';
import { ChatAppSettingsService } from './chat-app-settings.service.ts';
import {
  ChatAppSettingsController,
  ChatEventsController,
  MyChatAppsController,
} from './chat-apps.controller.ts';
import { ChatCardsScheduler } from './chat-cards.scheduler.ts';
import { ChatCardsService } from './chat-cards.service.ts';
import { ChatEventsService } from './chat-events.service.ts';

/**
 * LINE, Slack and Teams (ADR 0011): setup, Chat Accounts and verified callbacks
 * (ticket 0057), cards and the button presses that decide through Decision Requests
 * (ticket 0058).
 */
@Module({
  imports: [InboxModule, DecisionRequestsModule, RedraftsModule],
  controllers: [ChatAppSettingsController, MyChatAppsController, ChatEventsController],
  providers: [
    { provide: TEAMS_KEY_SOURCE, useFactory: () => new OpenIdKeySource() },
    ChatAdapters,
    ChatAppSettingsService,
    ChatAccountsService,
    ChatCardsService,
    ChatCardsScheduler,
    ChatActionsService,
    ChatEventsService,
  ],
})
export class ChatAppsModule {}
