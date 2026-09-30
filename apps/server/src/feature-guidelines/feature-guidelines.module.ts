import { Module } from '@nestjs/common';
import { FeatureGuidelinesController } from './feature-guidelines.controller.ts';
import { FeatureGuidelinesService } from './feature-guidelines.service.ts';

/** Feature Guidelines: the Organization default and Project overrides (REQUIREMENT §3.8). */
@Module({
  controllers: [FeatureGuidelinesController],
  providers: [FeatureGuidelinesService],
  exports: [FeatureGuidelinesService],
})
export class FeatureGuidelinesModule {}
