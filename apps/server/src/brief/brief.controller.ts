import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  ApproveProposalInput,
  BriefDiffQuery,
  RevertBriefInput,
  WriteBriefInput,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { BriefService } from './brief.service.ts';

@Controller()
export class BriefController {
  constructor(private readonly brief: BriefService) {}

  /** The current Project Brief; the empty template as version 0 before anyone saves one. */
  @Get('projects/:id/brief')
  current(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.brief.current(user, id);
  }

  @Get('projects/:id/brief-versions')
  versions(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.brief.listVersions(user, id);
  }

  @Post('projects/:id/brief-versions')
  write(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: WriteBriefInput }) body: WriteBriefInput,
  ) {
    return this.brief.write(user, id, body);
  }

  @Get('projects/:id/brief-versions/:version')
  version(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.brief.getVersion(user, id, version);
  }

  @Post('projects/:id/brief-versions/:version/revert')
  revert(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body({ schema: RevertBriefInput }) body: RevertBriefInput,
  ) {
    return this.brief.revert(user, id, version, body);
  }

  @Get('projects/:id/brief-diff')
  diff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: BriefDiffQuery }) query: BriefDiffQuery,
  ) {
    return this.brief.diff(user, id, query.from, query.to);
  }

  @Get('projects/:id/brief-proposals')
  proposals(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.brief.listProposals(user, id);
  }

  @Get('brief-proposals/:id')
  proposal(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.brief.getProposal(user, id);
  }

  @Post('brief-proposals/:id/approve')
  approve(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ApproveProposalInput }) body: ApproveProposalInput,
  ) {
    return this.brief.approve(user, id, body?.redraft);
  }

  @Post('brief-proposals/:id/reject')
  reject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.brief.reject(user, id);
  }
}
