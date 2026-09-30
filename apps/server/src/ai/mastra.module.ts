import { Global, Logger, Module } from '@nestjs/common';
import { loadAiConfig } from './ai.config.ts';
import { AI_PORT, type AiPort } from './ai.port.ts';
import { FakeAiPort } from './fake-ai.port.ts';
import { MastraAiPort } from './mastra-ai.port.ts';

// VORASAAN_AI=fake runs the server without an LLM key (local demos, UI work).
// Tests replace AI_PORT with FakeAiPort via overrideProvider.
@Global()
@Module({
  providers: [
    {
      provide: AI_PORT,
      useFactory: (): AiPort => {
        if (process.env.VORASAAN_AI === 'fake') {
          new Logger('MastraModule').warn('VORASAAN_AI=fake: using canned AI output');
          return new FakeAiPort();
        }
        return new MastraAiPort(loadAiConfig());
      },
    },
  ],
  exports: [AI_PORT],
})
export class MastraModule {}
