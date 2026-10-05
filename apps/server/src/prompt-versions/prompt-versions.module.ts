import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { RedraftsModule } from '../redrafts/redrafts.module.ts';
import { ModelSuggestionsController, ModelSuggestionsService } from './model-suggestions.ts';
import { PromptEvalsService } from './prompt-evals.service.ts';
import { PromptProposalsService } from './prompt-proposals.service.ts';
import {
  PromptAnalysisSettingsController,
  PromptSettings,
  PromptVersionsController,
} from './prompt-versions.controller.ts';
import { PromptReplay } from './replay.ts';

// PromptVersionsService itself lives in the global MastraModule: every AI call asks it
// which version of its prompt to render. The AI's proposals (ticket 0072) are redrafted
// through RedraftsService, like every AI proposal.
@Module({
  imports: [FeatureGuidelinesModule, RedraftsModule],
  controllers: [
    PromptVersionsController,
    PromptAnalysisSettingsController,
    ModelSuggestionsController,
  ],
  providers: [
    PromptSettings,
    PromptEvalsService,
    PromptReplay,
    PromptProposalsService,
    ModelSuggestionsService,
  ],
  exports: [PromptEvalsService, PromptProposalsService],
})
export class PromptVersionsModule {}
