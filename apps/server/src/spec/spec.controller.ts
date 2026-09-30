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
import { RevertSpecInput, SpecDiffQuery } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { SpecService } from './spec.service.ts';

@Controller()
export class SpecController {
  constructor(private readonly spec: SpecService) {}

  @Get('spec-proposals/:id')
  getProposal(@Param('id', ParseUUIDPipe) id: string) {
    return this.spec.getProposal(id);
  }

  @Post('spec-proposals/:id/approve')
  approve(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.approve(user, id);
  }

  @Post('spec-proposals/:id/reject')
  reject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.reject(user, id);
  }

  @Post('features/:id/spec-proposals/from-attachments')
  proposeFromAttachments(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.proposeFromAttachments(user, id);
  }

  @Get('features/:id/spec-versions')
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.spec.listVersions(id);
  }

  @Get('features/:id/spec-versions/:version')
  version(@Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number) {
    return this.spec.getVersion(id, version);
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
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: SpecDiffQuery }) query: SpecDiffQuery,
  ) {
    return this.spec.diff(id, query.from, query.to);
  }

  @Get('features/:id/decision-log')
  decisionLog(@Param('id', ParseUUIDPipe) id: string) {
    return this.spec.decisionLog(id);
  }
}
