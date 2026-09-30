import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  ListDecisionRequestsQuery,
  RaiseDecisionRequestInput,
  SubmitDecisionRequestInput,
} from '@vorasaan/shared';
import { CurrentUser } from '../dev-identity/dev-user.guard.ts';
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
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post(':id/submit')
  submit(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SubmitDecisionRequestInput }) body: SubmitDecisionRequestInput,
  ) {
    return this.service.submit(user, id, body);
  }

  @Post(':id/withdraw')
  withdraw(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.withdraw(user, id);
  }
}
