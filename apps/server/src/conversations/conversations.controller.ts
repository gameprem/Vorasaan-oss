import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  ListConversationsQuery,
  SendConversationMessageInput,
  StartConversationInput,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { ConversationsService } from './conversations.service.ts';

/**
 * Conversations (ADR 0008, ticket 0042). Every route is the owner's own: anyone
 * else gets 404. Replies stream over `GET /events`; each POST answers once the
 * reply is complete and stored, or with a 502 (ConversationReplyFailed).
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post()
  start(
    @CurrentUser() user: User,
    @Body({ schema: StartConversationInput }) body: StartConversationInput,
  ) {
    return this.conversations.start(user, body);
  }

  /** `?recent` for the Sidebar; `projectId` or `featureId` for one scope. */
  @Get()
  list(
    @CurrentUser() user: User,
    @Query({ schema: ListConversationsQuery }) query: ListConversationsQuery,
  ) {
    return this.conversations.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.get(user, id);
  }

  @Post(':id/messages')
  send(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SendConversationMessageInput }) body: SendConversationMessageInput,
  ) {
    return this.conversations.send(user, id, body.content);
  }

  /** After a 502: asks the AI again to reply to the last message. */
  @Post(':id/retry')
  retry(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.retry(user, id);
  }

  /**
   * Stops the reply being written (ticket 0046): what it wrote so far is kept as
   * the reply, and the request that asked for it answers with it. 409 when no
   * reply is being written.
   */
  @Post(':id/stop')
  @HttpCode(202)
  stop(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.stop(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.conversations.delete(user, id);
  }
}

/** Grilling Conversations (ticket 0044): each holder of a round's Team Role answers in their own. */
@Controller('grillings')
export class GrillingConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /**
   * My Grilling Conversation for the round being asked, opened if I have none
   * yet. Only holders of the round's Team Role (403); 409 once it isn't running.
   */
  @Post(':id/conversation')
  open(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.openGrilling(user, id);
  }
}
