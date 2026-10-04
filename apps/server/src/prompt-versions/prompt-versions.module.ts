import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { PromptEvalsService } from './prompt-evals.service.ts';
import { PromptSettings, PromptVersionsController } from './prompt-versions.controller.ts';
import { PromptReplay } from './replay.ts';

// PromptVersionsService itself lives in the global MastraModule: every AI call asks it
// which version of its prompt to render.
@Module({
  imports: [FeatureGuidelinesModule],
  controllers: [PromptVersionsController],
  providers: [PromptSettings, PromptEvalsService, PromptReplay],
  exports: [PromptEvalsService],
})
export class PromptVersionsModule {}
