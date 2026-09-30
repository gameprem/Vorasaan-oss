import { Global, Module } from '@nestjs/common';
import { loadAiConfig } from './ai.config.ts';
import { AI_PORT } from './ai.port.ts';
import { MastraAiPort } from './mastra-ai.port.ts';

// Tests replace AI_PORT with FakeAiPort via overrideProvider.
@Global()
@Module({
  providers: [{ provide: AI_PORT, useFactory: () => new MastraAiPort(loadAiConfig()) }],
  exports: [AI_PORT],
})
export class MastraModule {}
