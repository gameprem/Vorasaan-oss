import { Global, Logger, Module } from '@nestjs/common';
import { loadAiConfig } from './ai.config.ts';
import { AI_PORT, type AiPort } from './ai.port.ts';
import {
  AI_CONNECTION_TESTER,
  type AiConnectionTester,
  AiSettingsService,
} from './ai-settings.service.ts';
import { FakeAiPort } from './fake-ai.port.ts';
import { MastraAiPort, pingModel } from './mastra-ai.port.ts';
import { toMastraModel } from './model-config.ts';

// The model comes from Settings (OrgIntegration) on every call; when nothing is
// configured yet, env vars apply (VORASAAN_MODEL*, ANTHROPIC_API_KEY...).
// VORASAAN_AI=fake runs without any LLM (local demos, UI work).
// Tests replace AI_PORT and AI_CONNECTION_TESTER via overrideProvider.
@Global()
@Module({
  providers: [
    {
      provide: AI_CONNECTION_TESTER,
      useValue: ((provider) => pingModel(toMastraModel(provider))) satisfies AiConnectionTester,
    },
    AiSettingsService,
    {
      provide: AI_PORT,
      inject: [AiSettingsService],
      useFactory: (settings: AiSettingsService): AiPort => {
        if (process.env.VORASAAN_AI === 'fake') {
          new Logger('MastraModule').warn('VORASAAN_AI=fake: using canned AI output');
          return new FakeAiPort();
        }
        return new MastraAiPort(async (task) => {
          const configured = await settings.resolved();
          if (configured) return toMastraModel(configured);
          const env = loadAiConfig();
          return task === 'generateChoices' ? env.generateChoicesModel : env.draftSpecProposalModel;
        });
      },
    },
  ],
  exports: [AI_PORT, AiSettingsService],
})
export class MastraModule {}
