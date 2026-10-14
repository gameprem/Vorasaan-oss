import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  CreateAiProviderInput,
  CreateApprovedModelInput,
  SetAiTaskModelsInput,
  UpdateAiProviderInput,
  UpdateApprovedModelInput,
} from '@vorasaan/shared';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { AdminOnly } from '../auth/admin.guard.ts';

/** Settings → AI models (ADR 0010): providers, Approved Models and the model per task. */
@AdminOnly()
@Controller('settings/ai')
export class AiSettingsController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get()
  view() {
    return this.settings.view();
  }

  @Get('providers')
  async providers() {
    return { providers: (await this.settings.view()).providers };
  }

  @Post('providers')
  createProvider(@Body({ schema: CreateAiProviderInput }) body: CreateAiProviderInput) {
    return this.settings.createProvider(body);
  }

  @Patch('providers/:id')
  updateProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: UpdateAiProviderInput }) body: UpdateAiProviderInput,
  ) {
    return this.settings.updateProvider(id, body);
  }

  /** OpenRouter's or Gemini's model list for the picker (tickets 0064, 0080); 422 for any other provider. */
  @Get('providers/:id/models')
  providerModels(@Param('id', ParseUUIDPipe) id: string) {
    return this.settings.providerModels(id);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  async deleteProvider(@Param('id', ParseUUIDPipe) id: string) {
    await this.settings.deleteProvider(id);
  }

  @Get('models')
  async models() {
    return { models: (await this.settings.view()).models };
  }

  @Post('models')
  createModel(@Body({ schema: CreateApprovedModelInput }) body: CreateApprovedModelInput) {
    return this.settings.createModel(body);
  }

  @Patch('models/:id')
  updateModel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: UpdateApprovedModelInput }) body: UpdateApprovedModelInput,
  ) {
    return this.settings.updateModel(id, body);
  }

  @Delete('models/:id')
  @HttpCode(204)
  async deleteModel(@Param('id', ParseUUIDPipe) id: string) {
    await this.settings.deleteModel(id);
  }

  /** Checks one Approved Model with a tiny real call. */
  @Post('models/:id/test')
  @HttpCode(200)
  testModel(@Param('id', ParseUUIDPipe) id: string) {
    return this.settings.testModel(id);
  }

  @Put('tasks')
  setTasks(@Body({ schema: SetAiTaskModelsInput }) body: SetAiTaskModelsInput) {
    return this.settings.setTaskModels(body);
  }
}
