import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { OrgFeatureGuidelinesInput, ProjectFeatureGuidelinesInput } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { FeatureGuidelinesService } from './feature-guidelines.service.ts';

@Controller()
export class FeatureGuidelinesController {
  constructor(private readonly guidelines: FeatureGuidelinesService) {}

  /** The Organization default: every member reads it; only Admins replace it. */
  @Get('settings/feature-guidelines')
  getDefault(@CurrentUser() user: User) {
    return this.guidelines.getDefault(user);
  }

  @Put('settings/feature-guidelines')
  replaceDefault(
    @CurrentUser() user: User,
    @Body({ schema: OrgFeatureGuidelinesInput }) body: OrgFeatureGuidelinesInput,
  ) {
    return this.guidelines.replaceDefault(user, body);
  }

  /** The Project's overrides (Admins and the POs of the Project's Teams). */
  @Get('projects/:id/feature-guidelines')
  getOverrides(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.guidelines.getOverrides(user, id);
  }

  @Put('projects/:id/feature-guidelines')
  replaceOverrides(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ProjectFeatureGuidelinesInput }) body: ProjectFeatureGuidelinesInput,
  ) {
    return this.guidelines.replaceOverrides(user, id, body);
  }

  /** The merged list, with each criterion's origin (everyone in the Organization). */
  @Get('projects/:id/feature-guidelines/effective')
  getEffective(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.guidelines.getEffective(user, id);
  }
}
