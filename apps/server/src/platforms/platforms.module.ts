import { Module } from '@nestjs/common';
import { PlatformsController } from './platforms.controller.ts';
import { PlatformsService } from './platforms.service.ts';

/** Platforms per Project, the Organization's default, and Features' targets (ADR 0009). */
@Module({
  controllers: [PlatformsController],
  providers: [PlatformsService],
  exports: [PlatformsService],
})
export class PlatformsModule {}
