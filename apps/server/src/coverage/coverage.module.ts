import { Module } from '@nestjs/common';
import { CoverageController } from './coverage.controller.ts';
import { CoverageService } from './coverage.service.ts';

/**
 * Coverage per Platform (ADR 0009, ticket 0051); exported so Spec drafting, Grilling and
 * the replay of Spec Proposals give the AI what is missing.
 */
@Module({
  controllers: [CoverageController],
  providers: [CoverageService],
  exports: [CoverageService],
})
export class CoverageModule {}
