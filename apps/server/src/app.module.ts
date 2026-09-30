import { Module } from '@nestjs/common';
import { FeatureModule } from './modules/feature/feature.module';
import { JiraModule } from './modules/jira/jira.module';
import { MastraModule } from './modules/mastra/mastra.module';

@Module({
  imports: [
    MastraModule, // ห่อหุ้ม Mastra Agent Engine
    FeatureModule, // จัดการ API หน้าบ้านและ CLI
    JiraModule, // จัดการ Atlassian Webhooks
  ],
})
export class AppModule {}
