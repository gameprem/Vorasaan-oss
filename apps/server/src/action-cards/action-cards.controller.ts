import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  ApproveActionCardInput,
  DeclineActionCardInput,
  RequestChangesInput,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { ActionCardsService } from './action-cards.service.ts';

/**
 * Action Cards (ADR 0008, ticket 0043). Only the owner of the card's
 * Conversation acts on it; anyone else gets 404. Each answers with the card
 * (`ActionCardView`) once the target's own service has done the work.
 */
@Controller('action-cards')
export class ActionCardsController {
  constructor(private readonly cards: ActionCardsService) {}

  @Post(':id/approve')
  approve(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ApproveActionCardInput }) body: ApproveActionCardInput,
  ) {
    return this.cards.approve(user, id, body);
  }

  /**
   * Request changes (ticket 0065): the AI writes the next Redraft of what the card
   * proposes. Answers with the card once the Redraft is ready.
   */
  @Post(':id/request-changes')
  requestChanges(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RequestChangesInput }) body: RequestChangesInput,
  ) {
    return this.cards.requestChanges(user, id, body);
  }

  @Post(':id/decline')
  decline(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: DeclineActionCardInput }) body: DeclineActionCardInput,
  ) {
    return this.cards.decline(user, id, body);
  }
}
