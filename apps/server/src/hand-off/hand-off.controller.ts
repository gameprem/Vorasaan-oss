import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { HandOffQuery, type HandOffView } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { HandOffService } from './hand-off.service.ts';

/** The Hand-off `vorasaan run` writes for a coding assistant (ticket 0079). */
@Controller()
export class HandOffController {
  constructor(private readonly handOffs: HandOffService) {}

  @Get('features/:id/hand-off')
  handOff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: HandOffQuery }) query: HandOffQuery,
  ): Promise<HandOffView> {
    return this.handOffs.handOff(user, id, query);
  }
}
