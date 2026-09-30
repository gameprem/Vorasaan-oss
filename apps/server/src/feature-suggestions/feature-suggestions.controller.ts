import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  AcceptFeatureSuggestionInput,
  DismissFeatureSuggestionInput,
  FeatureFitInput,
  GenerateFeatureSuggestionsInput,
  ListFeatureSuggestionsQuery,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { FeatureSuggestionsService } from './feature-suggestions.service.ts';

@Controller()
export class FeatureSuggestionsController {
  constructor(private readonly suggestions: FeatureSuggestionsService) {}

  /** The Project's POs and Admins; `{ count }` is optional (default 5, at most 10). */
  @Post('projects/:id/feature-suggestions/generate')
  generate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: GenerateFeatureSuggestionsInput }) body: GenerateFeatureSuggestionsInput,
  ) {
    return this.suggestions.generate(user, id, body);
  }

  @Get('projects/:id/feature-suggestions')
  list(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: ListFeatureSuggestionsQuery }) query: ListFeatureSuggestionsQuery,
  ) {
    return this.suggestions.list(user, id, query);
  }

  @Post('feature-suggestions/:id/accept')
  accept(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: AcceptFeatureSuggestionInput }) body: AcceptFeatureSuggestionInput,
  ) {
    return this.suggestions.accept(user, id, body);
  }

  @Post('feature-suggestions/:id/dismiss')
  dismiss(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: DismissFeatureSuggestionInput }) body: DismissFeatureSuggestionInput,
  ) {
    return this.suggestions.dismiss(user, id, body);
  }

  /** Checks a Feature about to be created against the effective Feature Guidelines; writes nothing. */
  @Post('projects/:id/feature-fit')
  @HttpCode(200)
  fit(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: FeatureFitInput }) body: FeatureFitInput,
  ) {
    return this.suggestions.fit(user, id, body);
  }
}
