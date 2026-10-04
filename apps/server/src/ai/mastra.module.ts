import { Global, Logger, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock.ts';
import { ReceiptingAiPort } from '../receipts/receipting.ai-port.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { AI_PORT, type AiPort } from './ai.port.ts';
import {
  AI_CONNECTION_TESTER,
  type AiConnectionTester,
  AiSettingsService,
} from './ai-settings.service.ts';
import { ContextBudgets } from './context-budget.ts';
import { FakeAiPort } from './fake-ai.port.ts';
import { MastraAiPort, pingModel } from './mastra-ai.port.ts';
import { toMastraModel } from './model-config.ts';
import { ModelRoutingAiPort } from './model-routing.ai-port.ts';

/**
 * The adapter that talks to the providers. Tests replace it with a FakeAiPort
 * (via overrideProvider), so the model routing in AI_PORT still runs and the
 * fake records the model of each call.
 */
export const AI_ENGINE = Symbol('AI_ENGINE');

// The model of each call is chosen from Settings (Approved Models, ADR 0010), or
// from env vars (VORASAAN_MODEL*, ANTHROPIC_API_KEY...): see AiSettingsService.chooseModel.
// VORASAAN_AI=fake runs without any LLM (local demos, UI work).
@Global()
@Module({
  providers: [
    {
      provide: AI_CONNECTION_TESTER,
      useValue: ((provider) => pingModel(toMastraModel(provider))) satisfies AiConnectionTester,
    },
    AiSettingsService,
    ContextBudgets,
    ReceiptsService,
    {
      provide: AI_ENGINE,
      useFactory: (): AiPort => {
        if (process.env.VORASAAN_AI === 'fake') {
          new Logger('MastraModule').warn('VORASAAN_AI=fake: using canned AI output');
          return new FakeAiPort();
        }
        return new MastraAiPort();
      },
    },
    // Every call: the model is chosen, then a Receipt is left (ticket 0070), then the
    // provider (or the fake) is called.
    {
      provide: AI_PORT,
      inject: [AI_ENGINE, AiSettingsService, ReceiptsService, CLOCK],
      useFactory: (
        engine: AiPort,
        settings: AiSettingsService,
        receipts: ReceiptsService,
        clock: Clock,
      ): AiPort =>
        new ModelRoutingAiPort(
          new ReceiptingAiPort(engine, receipts, clock),
          (task, approvedModelId) => settings.chooseModel(task, approvedModelId),
        ),
    },
  ],
  exports: [AI_PORT, AI_ENGINE, AiSettingsService, ContextBudgets, ReceiptsService],
})
export class MastraModule {}
