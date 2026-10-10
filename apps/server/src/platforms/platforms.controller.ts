import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  PlatformTemplateInput,
  ProjectPlatformsInput,
  SetFeaturePlatformsInput,
} from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { PlatformsService } from './platforms.service.ts';

@Controller()
export class PlatformsController {
  constructor(private readonly platforms: PlatformsService) {}

  /** The Organization's default list: every member reads it; only Admins replace it. */
  @Get('settings/platform-template')
  template(@CurrentUser() user: User) {
    return this.platforms.getTemplate(user);
  }

  @Put('settings/platform-template')
  replaceTemplate(
    @CurrentUser() user: User,
    @Body({ schema: PlatformTemplateInput }) body: PlatformTemplateInput,
  ) {
    return this.platforms.replaceTemplate(user, body);
  }

  /** The Project's own list: everyone reads it; Admins and the Project's POs replace it. */
  @Get('projects/:id/platforms')
  forProject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.platforms.forProject(user, id);
  }

  @Put('projects/:id/platforms')
  replaceForProject(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ProjectPlatformsInput }) body: ProjectPlatformsInput,
  ) {
    return this.platforms.replaceForProject(user, id, body);
  }

  /** The Platforms a Feature targets (Admins and the Team's POs). */
  @Put('features/:id/platforms')
  setFeatureTargets(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SetFeaturePlatformsInput }) body: SetFeaturePlatformsInput,
  ) {
    return this.platforms.setFeatureTargets(user, id, body);
  }

  /** What the Feature's first Spec starts from: a section per target Platform. */
  @Get('features/:id/spec-template')
  specTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.platforms.specTemplate(id);
  }
}
