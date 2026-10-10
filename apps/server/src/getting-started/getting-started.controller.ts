import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { OrganizationSettingsInput } from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser } from '../auth/identity.guard.ts';
import { GettingStartedService } from './getting-started.service.ts';

@Controller()
export class GettingStartedController {
  constructor(private readonly gettingStarted: GettingStartedService) {}

  /** The Organization's name and default language: every member reads them. */
  @Get('settings/organization')
  organization(@CurrentUser() user: User) {
    return this.gettingStarted.organizationSettings(user);
  }

  @AdminOnly()
  @Put('settings/organization')
  saveOrganization(
    @CurrentUser() user: User,
    @Body({ schema: OrganizationSettingsInput }) body: OrganizationSettingsInput,
  ) {
    return this.gettingStarted.saveOrganizationSettings(user, body);
  }

  /** The Getting started checklist: Admins only; Members never see it. */
  @AdminOnly()
  @Get('me/getting-started')
  checklist(@CurrentUser() user: User) {
    return this.gettingStarted.checklist(user);
  }

  @AdminOnly()
  @Post('me/getting-started/dismiss')
  @HttpCode(200)
  dismiss(@CurrentUser() user: User) {
    return this.gettingStarted.dismiss(user);
  }
}
