import { Module } from '@nestjs/common';
import { FeatureGuidelinesController } from './feature-guidelines.controller.ts';
import { FeatureGuidelinesService } from './feature-guidelines.service.ts';
import { ProjectFoundation } from './project-foundation.ts';

/** Feature Guidelines: the Organization default and Project overrides (REQUIREMENT §3.8). */
@Module({
  controllers: [FeatureGuidelinesController],
  providers: [FeatureGuidelinesService, ProjectFoundation],
  exports: [FeatureGuidelinesService, ProjectFoundation],
})
export class FeatureGuidelinesModule {}
