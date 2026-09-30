import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { ListNotificationsQuery } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { InboxService } from './inbox.service.ts';
import { NotificationsService } from './notifications.service.ts';

/** The caller's own Inbox Items and Notifications; nobody can read anyone else's. */
@Controller()
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('inbox')
  async items(@CurrentUser() user: User) {
    await this.notifications.startDelegations(user.id);
    return this.inbox.items(user.id);
  }

  @Get('notifications')
  list(
    @CurrentUser() user: User,
    @Query({ schema: ListNotificationsQuery }) query: ListNotificationsQuery,
  ) {
    return this.notifications.list(user.id, query);
  }

  @Post('notifications/read-all')
  readAll(@CurrentUser() user: User) {
    return this.notifications.markAllRead(user.id);
  }

  @Post('notifications/:id/read')
  read(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
