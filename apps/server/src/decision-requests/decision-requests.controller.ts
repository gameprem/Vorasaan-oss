import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  DecideInput,
  ListDecisionRequestsQuery,
  PostRequestMessageInput,
  RaiseDecisionRequestInput,
  ReassignInput,
  SubmitDecisionRequestInput,
} from '@vorasaan/shared';
import { CurrentToken, CurrentUser } from '../auth/identity.guard.ts';
import { PAT_PREFIX } from '../auth/tokens.ts';
import { DecisionRequestsService } from './decision-requests.service.ts';

@Controller('decision-requests')
export class DecisionRequestsController {
  constructor(private readonly service: DecisionRequestsService) {}

  @Post()
  raise(
    @CurrentUser() user: User,
    @Body({ schema: RaiseDecisionRequestInput }) body: RaiseDecisionRequestInput,
  ) {
    return this.service.raise(user, body);
  }

  @Get()
  list(
    @CurrentUser() user: User,
    @Query({ schema: ListDecisionRequestsQuery }) query: ListDecisionRequestsQuery,
  ) {
    return this.service.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user, id);
  }

  @Post(':id/submit')
  submit(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SubmitDecisionRequestInput }) body: SubmitDecisionRequestInput,
  ) {
    return this.service.submit(user, id, body);
  }

  @Post(':id/claim')
  claim(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.claim(user, id);
  }

  @Post(':id/reassign')
  reassign(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ReassignInput }) body: ReassignInput,
  ) {
    return this.service.reassign(user, id, body);
  }

  @Post(':id/messages')
  postMessage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: PostRequestMessageInput }) body: PostRequestMessageInput,
  ) {
    return this.service.postMessage(user, id, body);
  }

  @Post(':id/decision')
  decide(
    @CurrentUser() user: User,
    @CurrentToken() token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: DecideInput }) body: DecideInput,
  ) {
    // The CLI signs in with a Personal Access Token; the web app with a session.
    return this.service.decide(user, id, body, token?.startsWith(PAT_PREFIX) ? 'CLI' : 'WEB');
  }

  @Post(':id/withdraw')
  withdraw(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.withdraw(user, id);
  }
}
