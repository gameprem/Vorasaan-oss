import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module.ts';
import { BriefController } from './brief.controller.ts';
import { BriefService } from './brief.service.ts';

/** The Project Brief and Brief Proposals; exported so Action Cards approve through it. */
@Module({
  imports: [InboxModule],
  controllers: [BriefController],
  providers: [BriefService],
  exports: [BriefService],
})
export class BriefModule {}
