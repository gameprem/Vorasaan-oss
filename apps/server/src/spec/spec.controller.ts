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
  DraftAcceptanceCriteriaInput,
  RejectProposalInput,
  RevertSpecInput,
  SpecDiffQuery,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { SpecService } from './spec.service.ts';

@Controller()
export class SpecController {
  constructor(private readonly spec: SpecService) {}

  @Get('spec-proposals/:id')
  getProposal(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.getProposal(user, id);
  }

  @Post('spec-proposals/:id/approve')
  approve(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ApproveProposalInput }) body: ApproveProposalInput,
  ) {
    return this.spec.approve(user, id, body?.redraft);
  }

  @Post('spec-proposals/:id/reject')
  reject(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RejectProposalInput }) body: RejectProposalInput,
  ) {
    return this.spec.reject(user, id, body?.reason);
  }

  @Post('features/:id/spec-proposals/from-attachments')
  proposeFromAttachments(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.proposeFromAttachments(user, id);
  }

  /** The AI drafts a Platform's acceptance criteria when it isn't QA ready (ticket 0051). */
  @Post('features/:id/coverage/acceptance-criteria')
  proposeAcceptanceCriteria(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: DraftAcceptanceCriteriaInput }) body: DraftAcceptanceCriteriaInput,
  ) {
    return this.spec.proposeAcceptanceCriteria(user, id, body.platformId);
  }

  @Get('features/:id/spec-versions')
  versions(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.listVersions(user, id);
  }

  @Get('features/:id/spec-versions/:version')
  version(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.spec.getVersion(user, id, version);
  }

  @Post('features/:id/spec-versions/:version/revert')
  revert(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body({ schema: RevertSpecInput }) body: RevertSpecInput,
  ) {
    return this.spec.revert(user, id, version, body);
  }

  @Get('features/:id/spec-diff')
  diff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: SpecDiffQuery }) query: SpecDiffQuery,
  ) {
    return this.spec.diff(user, id, query.from, query.to);
  }

  @Get('features/:id/decision-log')
  decisionLog(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.decisionLog(user, id);
  }
}
