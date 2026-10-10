import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { ProposalKind, User } from '@vorasaan/db';
import {
  ProposalKind as ProposalKindSchema,
  RedraftDiffQuery,
  RequestChangesInput,
} from '@vorasaan/shared';
import { z } from 'zod';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser } from '../auth/identity.guard.ts';
import { RedraftsService } from './redrafts.service.ts';

const EvalCasesQuery = z.object({ kind: ProposalKindSchema.optional() });
type EvalCasesQuery = z.infer<typeof EvalCasesQuery>;

/**
 * Request changes and Redrafts (ADR 0013, ticket 0065), on each kind of AI proposal:
 * - `POST …/request-changes` writes the next Redraft from `RequestChangesInput` and
 *   answers with it, every Redraft and the diff from the one before
 *   (`RequestChangesResult`), once the AI has written it;
 * - `GET …/redrafts` lists them (`ProposalRedraftsView`), and `GET …/redrafts/diff`
 *   compares any two.
 * A Decision Request's Choices live under `decision-requests/:id/choices`; a Prompt Version
 * the AI proposed (ticket 0072) under `prompt-versions/:id`, for Admins only. An Action
 * Card has its own `POST /action-cards/:id/request-changes`.
 */
@Controller()
export class RedraftsController {
  constructor(private readonly redrafts: RedraftsService) {}

  // ─── Spec Proposals ───────────────────────────────────────────────────────

  @Post('spec-proposals/:id/request-changes')
  specRequest(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RequestChangesInput }) body: RequestChangesInput,
  ) {
    return this.request(user, 'SPEC_PROPOSAL', id, body);
  }

  @Get('spec-proposals/:id/redrafts')
  specList(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.redrafts.list(user, { kind: 'SPEC_PROPOSAL', id });
  }

  @Get('spec-proposals/:id/redrafts/diff')
  specDiff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: RedraftDiffQuery }) query: RedraftDiffQuery,
  ) {
    return this.redrafts.diff(user, { kind: 'SPEC_PROPOSAL', id }, query.from, query.to);
  }

  // ─── Brief Proposals ──────────────────────────────────────────────────────

  @Post('brief-proposals/:id/request-changes')
  briefRequest(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RequestChangesInput }) body: RequestChangesInput,
  ) {
    return this.request(user, 'BRIEF_PROPOSAL', id, body);
  }

  @Get('brief-proposals/:id/redrafts')
  briefList(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.redrafts.list(user, { kind: 'BRIEF_PROPOSAL', id });
  }

  @Get('brief-proposals/:id/redrafts/diff')
  briefDiff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: RedraftDiffQuery }) query: RedraftDiffQuery,
  ) {
    return this.redrafts.diff(user, { kind: 'BRIEF_PROPOSAL', id }, query.from, query.to);
  }

  // ─── Feature Suggestions ──────────────────────────────────────────────────

  @Post('feature-suggestions/:id/request-changes')
  suggestionRequest(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RequestChangesInput }) body: RequestChangesInput,
  ) {
    return this.request(user, 'FEATURE_SUGGESTION', id, body);
  }

  @Get('feature-suggestions/:id/redrafts')
  suggestionList(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.redrafts.list(user, { kind: 'FEATURE_SUGGESTION', id });
  }

  @Get('feature-suggestions/:id/redrafts/diff')
  suggestionDiff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: RedraftDiffQuery }) query: RedraftDiffQuery,
  ) {
    return this.redrafts.diff(user, { kind: 'FEATURE_SUGGESTION', id }, query.from, query.to);
  }

  // ─── A Decision Request's Choices ─────────────────────────────────────────

  @Post('decision-requests/:id/choices/request-changes')
  choicesRequest(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RequestChangesInput }) body: RequestChangesInput,
  ) {
    return this.request(user, 'CHOICES', id, body);
  }

  @Get('decision-requests/:id/choices/redrafts')
  choicesList(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.redrafts.list(user, { kind: 'CHOICES', id });
  }

  @Get('decision-requests/:id/choices/redrafts/diff')
  choicesDiff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: RedraftDiffQuery }) query: RedraftDiffQuery,
  ) {
    return this.redrafts.diff(user, { kind: 'CHOICES', id }, query.from, query.to);
  }

  // ─── Prompt Versions the AI proposed (ticket 0072), Admins only ───────────

  @Post('prompt-versions/:id/request-changes')
  @AdminOnly()
  promptRequest(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RequestChangesInput }) body: RequestChangesInput,
  ) {
    return this.request(user, 'PROMPT_VERSION', id, body);
  }

  @Get('prompt-versions/:id/redrafts')
  @AdminOnly()
  promptList(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.redrafts.list(user, { kind: 'PROMPT_VERSION', id });
  }

  @Get('prompt-versions/:id/redrafts/diff')
  @AdminOnly()
  promptDiff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: RedraftDiffQuery }) query: RedraftDiffQuery,
  ) {
    return this.redrafts.diff(user, { kind: 'PROMPT_VERSION', id }, query.from, query.to);
  }

  // ─── Design Doc proposals (ticket 0069) ───────────────────────────────────

  @Post('design-doc-proposals/:id/request-changes')
  designDocRequest(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: RequestChangesInput }) body: RequestChangesInput,
  ) {
    return this.request(user, 'DESIGN_DOC_PROPOSAL', id, body);
  }

  @Get('design-doc-proposals/:id/redrafts')
  designDocList(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.redrafts.list(user, { kind: 'DESIGN_DOC_PROPOSAL', id });
  }

  @Get('design-doc-proposals/:id/redrafts/diff')
  designDocDiff(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: RedraftDiffQuery }) query: RedraftDiffQuery,
  ) {
    return this.redrafts.diff(user, { kind: 'DESIGN_DOC_PROPOSAL', id }, query.from, query.to);
  }

  // ─── Evals ────────────────────────────────────────────────────────────────

  /** Every Request changes as an eval case for the redraft prompts. Admins only. */
  @Get('redrafts/eval-cases')
  @AdminOnly()
  evalCases(@Query({ schema: EvalCasesQuery }) query: EvalCasesQuery) {
    return this.redrafts.evalCases(query.kind);
  }

  private request(user: User, kind: ProposalKind, id: string, body: RequestChangesInput) {
    return this.redrafts.requestChanges(user, { kind, id }, body);
  }
}
