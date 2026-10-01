import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { ApproveActionCardInput, DeclineActionCardInput } from '@vorasaan/shared';
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

  @Post(':id/decline')
  decline(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: DeclineActionCardInput }) body: DeclineActionCardInput,
  ) {
    return this.cards.decline(user, id, body);
  }
}
