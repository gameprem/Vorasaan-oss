import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { ProjectResponseWindowsInput, ResponseWindowSettingsInput } from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser } from '../auth/identity.guard.ts';
import { ResponseWindowsService } from './response-windows.service.ts';

@Controller()
export class ResponseWindowsController {
  constructor(private readonly windows: ResponseWindowsService) {}

  /** The working calendar and default windows: every member reads them; Admins change them. */
  @Get('settings/response-windows')
  getSettings(@CurrentUser() user: User) {
    return this.windows.getSettings(user);
  }

  @AdminOnly()
  @Put('settings/response-windows')
  replaceSettings(
    @CurrentUser() user: User,
    @Body({ schema: ResponseWindowSettingsInput }) body: ResponseWindowSettingsInput,
  ) {
    return this.windows.replaceSettings(user, body);
  }

  /** A Project's own windows, and the ones in effect there. */
  @Get('projects/:id/response-windows')
  getProject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.windows.getProject(user, id);
  }

  @AdminOnly()
  @Put('projects/:id/response-windows')
  replaceProject(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: ProjectResponseWindowsInput }) body: ProjectResponseWindowsInput,
  ) {
    return this.windows.replaceProject(user, id, body);
  }
}
