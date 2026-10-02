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
import { CreateDelegationInput, MyDelegationsQuery } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { DelegationsService } from './delegations.service.ts';

@Controller('teams/:id/delegations')
export class DelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get()
  list(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) teamId: string) {
    return this.service.list(user, teamId);
  }

  @Post()
  create(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) teamId: string,
    @Body({ schema: CreateDelegationInput }) body: CreateDelegationInput,
  ) {
    return this.service.create(user, teamId, body);
  }

  @Delete(':delegationId')
  @HttpCode(204)
  async delete(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) teamId: string,
    @Param('delegationId', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(user, teamId, id);
  }
}

/** The caller's own Delegations across Teams: the ones they gave, or the ones naming them. */
@Controller('me/delegations')
export class MyDelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @Query({ schema: MyDelegationsQuery }) query: MyDelegationsQuery,
  ) {
    return this.service.mine(user, query);
  }
}
