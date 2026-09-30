import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { AiSettingsInput } from '@vorasaan/shared';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { AdminOnly } from '../auth/admin.guard.ts';

@AdminOnly()
@Controller('settings/ai')
export class AiSettingsController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get()
  view() {
    return this.settings.view();
  }

  @Put()
  save(@Body({ schema: AiSettingsInput }) body: AiSettingsInput) {
    return this.settings.save(body);
  }

  /** Checks a config with a tiny real call, without saving it. */
  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: AiSettingsInput }) body: AiSettingsInput) {
    return this.settings.test(body);
  }
}
