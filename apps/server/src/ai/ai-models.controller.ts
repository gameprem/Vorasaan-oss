import { Controller, Get } from '@nestjs/common';
import { AiSettingsService } from './ai-settings.service.ts';

/** The Approved Models anyone in the Organization may use: names and notes, never a key or URL. */
@Controller('ai')
export class AiModelsController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get('models')
  models() {
    return this.settings.publicModels();
  }
}
