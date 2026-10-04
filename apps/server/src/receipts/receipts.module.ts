import { Module } from '@nestjs/common';
import { ReceiptsController } from './receipts.controller.ts';
import { ReceiptsScheduler } from './receipts.scheduler.ts';

// ReceiptsService itself lives in the global MastraModule: every AI call writes through it.
@Module({
  controllers: [ReceiptsController],
  providers: [ReceiptsScheduler],
})
export class ReceiptsModule {}
