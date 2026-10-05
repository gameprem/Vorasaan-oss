import { Module } from '@nestjs/common';
import { CoverageModule } from '../coverage/coverage.module.ts';
import { InboxModule } from '../inbox/inbox.module.ts';
import { SpecController } from './spec.controller.ts';
import { SpecService } from './spec.service.ts';

/** Spec Versions and Spec Proposals; exported so Action Cards approve through it. */
@Module({
  imports: [InboxModule, CoverageModule],
  controllers: [SpecController],
  providers: [SpecService],
  exports: [SpecService],
})
export class SpecModule {}
