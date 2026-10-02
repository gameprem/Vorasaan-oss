import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module.ts';
import { OpenIdKeySource, TEAMS_KEY_SOURCE } from './adapters/teams-keys.ts';
import { ChatAccountsService } from './chat-accounts.service.ts';
import { ChatAdapters } from './chat-adapters.ts';
import { ChatAppSettingsService } from './chat-app-settings.service.ts';
import {
  ChatAppSettingsController,
  ChatEventsController,
  MyChatAppsController,
} from './chat-apps.controller.ts';
import { ChatEventsService } from './chat-events.service.ts';

/** LINE, Slack and Teams: setup, Chat Accounts and verified callbacks (ADR 0011, ticket 0057). */
@Module({
  imports: [InboxModule],
  controllers: [ChatAppSettingsController, MyChatAppsController, ChatEventsController],
  providers: [
    { provide: TEAMS_KEY_SOURCE, useFactory: () => new OpenIdKeySource() },
    ChatAdapters,
    ChatAppSettingsService,
    ChatAccountsService,
    ChatEventsService,
  ],
  // Ticket 0058 sends cards through these.
  exports: [ChatAdapters, ChatAppSettingsService, ChatAccountsService],
})
export class ChatAppsModule {}
