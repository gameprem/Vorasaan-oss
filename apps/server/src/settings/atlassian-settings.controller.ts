import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { AtlassianSettingsInput } from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { AtlassianSettingsService } from './atlassian-settings.service.ts';

/** The Atlassian site for Confluence and Jira Attachments. The API token is never returned. */
@AdminOnly()
@Controller('settings/atlassian')
export class AtlassianSettingsController {
  constructor(private readonly settings: AtlassianSettingsService) {}

  @Get()
  view() {
    return this.settings.view();
  }

  @Put()
  save(@Body({ schema: AtlassianSettingsInput }) body: AtlassianSettingsInput) {
    return this.settings.save(body);
  }

  /** Checks the site, email and token with a read-only call, without saving them. */
  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: AtlassianSettingsInput }) body: AtlassianSettingsInput) {
    return this.settings.test(body);
  }
}
