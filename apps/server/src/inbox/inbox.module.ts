import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.ts';
import { ChatCardSignals } from './chat-card-signals.ts';
import { EventBus } from './event-bus.ts';
import { EventsController } from './events.controller.ts';
import { InboxController } from './inbox.controller.ts';
import { InboxService } from './inbox.service.ts';
import { NotificationsService } from './notifications.service.ts';

/** Inbox Items, Notifications and the `GET /events` stream (REQUIREMENT §3.5). */
@Module({
  controllers: [InboxController, EventsController],
  providers: [EventBus, InboxService, NotificationsService, AuthService, ChatCardSignals],
  exports: [NotificationsService, EventBus, ChatCardSignals],
})
export class InboxModule {}
