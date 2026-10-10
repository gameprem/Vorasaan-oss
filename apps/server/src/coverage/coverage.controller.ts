import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { CurrentUser } from '../auth/identity.guard.ts';
import { CoverageService } from './coverage.service.ts';

@Controller()
export class CoverageController {
  constructor(private readonly coverage: CoverageService) {}

  /** A Feature's target Platforms, each covered or missing and why (ADR 0009). */
  @Get('features/:id/coverage')
  forFeature(@Param('id', ParseUUIDPipe) id: string) {
    return this.coverage.forFeature(id);
  }

  /** The Project's Feature × Platform matrix, and the Platforms no Feature covers. */
  @Get('projects/:id/coverage')
  forProject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.coverage.forProject(user, id);
  }
}
