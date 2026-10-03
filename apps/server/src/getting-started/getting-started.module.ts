import { Module } from '@nestjs/common';
import { GettingStartedController } from './getting-started.controller.ts';
import { GettingStartedService } from './getting-started.service.ts';

/** After first-run setup (ticket 0063): the Organization language and Getting started. */
@Module({
  controllers: [GettingStartedController],
  providers: [GettingStartedService],
})
export class GettingStartedModule {}
