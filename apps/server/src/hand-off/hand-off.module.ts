import { Module } from '@nestjs/common';
import { FeatureGuidelinesModule } from '../feature-guidelines/feature-guidelines.module.ts';
import { HandOffController } from './hand-off.controller.ts';
import { HandOffService } from './hand-off.service.ts';

/**
 * The Hand-off (REQUIREMENT 15, ticket 0079): a Feature's latest Spec, its Decisions, the
 * approved Design Doc of the developer's Platform, the Project rules and retrieved context,
 * as one Markdown file for a coding assistant. Retrieval and Atlassian are global modules.
 */
@Module({
  imports: [FeatureGuidelinesModule],
  controllers: [HandOffController],
  providers: [HandOffService],
  exports: [HandOffService],
})
export class HandOffModule {}
