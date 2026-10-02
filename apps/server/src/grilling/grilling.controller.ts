import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  AnswerGrillingQuestionInput,
  ListGrillingsQuery,
  SkipGrillingRoundInput,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { GrillingService } from './grilling.service.ts';

@Controller()
export class GrillingController {
  constructor(private readonly grilling: GrillingService) {}

  /** The Project's POs and Admins start a Grilling; at most one runs per Project. */
  @Post('projects/:id/grillings')
  start(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.grilling.start(user, id);
  }

  @Get('projects/:id/grillings')
  listForProject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.grilling.listForProject(user, id);
  }

  /** `?awaiting=me`: the Grillings whose current round is asked of me. */
  @Get('grillings')
  awaiting(
    @CurrentUser() user: User,
    @Query({ schema: ListGrillingsQuery }) _query: ListGrillingsQuery,
  ) {
    return this.grilling.awaiting(user);
  }

  @Get('grillings/:id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.grilling.get(user, id);
  }

  @Post('grillings/:id/questions/:questionId/answer')
  answer(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body({ schema: AnswerGrillingQuestionInput }) body: AnswerGrillingQuestionInput,
  ) {
    return this.grilling.answer(user, id, questionId, body);
  }

  @Post('grillings/:id/skip-round')
  skipRound(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SkipGrillingRoundInput }) body: SkipGrillingRoundInput,
  ) {
    return this.grilling.skipRound(user, id, body);
  }

  @Post('grillings/:id/cancel')
  cancel(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.grilling.cancel(user, id);
  }
}
