import { Global, Module } from '@nestjs/common';
import { AtlassianSettingsController } from './atlassian-settings.controller.ts';
import { AtlassianSettingsService } from './atlassian-settings.service.ts';

/** The Organization's Atlassian connection, used by Attachments and the Feature view. */
@Global()
@Module({
  controllers: [AtlassianSettingsController],
  providers: [AtlassianSettingsService],
  exports: [AtlassianSettingsService],
})
export class AtlassianModule {}
