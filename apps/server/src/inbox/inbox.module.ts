import { Module } from '@nestjs/common';
import { EventBus } from './event-bus.ts';
import { EventsController } from './events.controller.ts';
import { InboxController } from './inbox.controller.ts';
import { InboxService } from './inbox.service.ts';
import { NotificationsService } from './notifications.service.ts';

/** Inbox Items, Notifications and the `GET /events` stream (REQUIREMENT §3.5). */
@Module({
  controllers: [InboxController, EventsController],
  providers: [EventBus, InboxService, NotificationsService],
  exports: [NotificationsService],
})
export class InboxModule {}
