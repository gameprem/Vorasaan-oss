import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  ApproveProposalInput,
  DesignDocKey,
  DesignTemplateKind,
  RejectProposalInput,
  RevertSpecInput,
  SetDesignTemplateInput,
  SpecDiffQuery,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { DesignDocsService } from './design-docs.service.ts';

/**
 * Design Docs (ADR 0014, ticket 0069). Reading is for everyone in the Feature's Organization;
 * drafting on request, approving, declining and reverting are for the Design Doc's approvers
 * (a Tech Lead or a Role Owner of its Platform's Team Roles). Request changes and Redrafts are
 * `RedraftsController`'s (`design-doc-proposals/:id/request-changes`, `…/redrafts`).
 */
@Controller()
export class DesignDocsController {
  constructor(private readonly designDocs: DesignDocsService) {}

  @Get('features/:id/design-docs')
  list(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.designDocs.list(user, id);
  }

  @Get('features/:id/design-docs/:key')
  detail(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key', { schema: DesignDocKey }) key: DesignDocKey,
  ) {
    return this.designDocs.detail(user, id, key);
  }

  @Post('features/:id/design-docs/:key/draft')
  draft(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key', { schema: DesignDocKey }) key: DesignDocKey,
  ) {
    return this.designDocs.requestDraft(user, id, key);
  }

  @Get('features/:id/design-docs/:key/diff')
  diff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key', { schema: DesignDocKey }) key: DesignDocKey,
    @Query({ schema: SpecDiffQuery }) query: SpecDiffQuery,
  ) {
    return this.designDocs.diff(user, id, key, query.from, query.to);
  }

  @Post('features/:id/design-docs/:key/versions/:version/revert')
  revert(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key', { schema: DesignDocKey }) key: DesignDocKey,
    @Param('version', ParseIntPipe) version: number,
    @Body({ schema: RevertSpecInput }) body: RevertSpecInput,
  ) {
    return this.designDocs.revert(user, id, key, version, body);
  }

  @Get('design-doc-proposals/:id')
  proposal(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.designDocs.getProposal(user, id);
  }

  @Post('design-doc-proposals/:id/approve')
  approve(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ApproveProposalInput }) body: ApproveProposalInput,
  ) {
    return this.designDocs.approve(user, id, body?.redraft);
  }

  @Post('design-doc-proposals/:id/decline')
  decline(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RejectProposalInput }) body: RejectProposalInput,
  ) {
    return this.designDocs.decline(user, id, body?.reason);
  }

  @Get('projects/:id/design-templates')
  templates(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.designDocs.templates(user, id);
  }

  @Put('projects/:id/design-templates/:kind')
  setTemplate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind', { schema: DesignTemplateKind }) kind: DesignTemplateKind,
    @Body({ schema: SetDesignTemplateInput }) body: SetDesignTemplateInput,
  ) {
    return this.designDocs.setTemplate(user, id, kind, body.markdown);
  }

  /** Back to the built-in template of that kind. */
  @Delete('projects/:id/design-templates/:kind')
  resetTemplate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind', { schema: DesignTemplateKind }) kind: DesignTemplateKind,
  ) {
    return this.designDocs.setTemplate(user, id, kind, null);
  }
}
