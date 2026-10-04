import type { AiTask } from '../ai/ai.config.ts';
import type { AiCallOptions, AiPort, CallUsage, ChatChunk } from '../ai/ai.port.ts';
import type { Clock } from '../clock/clock.ts';
import type { ReceiptEntry } from './receipts.service.ts';
import { receiptError } from './redact.ts';

/** Where Receipts go: `ReceiptsService.record`, which never throws and never waits. */
export type ReceiptSink = { record(entry: ReceiptEntry): void };

/** Sums the usage of a call's provider requests; a field nobody reported stays null. */
function addUsage(a: CallUsage | null, b: CallUsage): CallUsage {
  if (!a) return { ...b };
  const sum = (x: number | null, y: number | null) =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
  };
}

/**
 * Leaves a Receipt for every AI call (ADR 0015, ticket 0070), failed ones included. It
 * sits between the model routing and the provider adapter (or the fake), so it sees the
 * model chosen for the call, its usage (`onUsage`) and how long it took, and hands them
 * to the sink once the call is done. Counting tokens is not an AI call: no Receipt.
 */
export class ReceiptingAiPort implements AiPort {
  constructor(
    private readonly engine: AiPort,
    private readonly sink: ReceiptSink,
    private readonly clock: Clock,
  ) {}

  private async run<T>(
    task: AiTask,
    options: AiCallOptions | undefined,
    call: (options: AiCallOptions) => Promise<T>,
  ): Promise<T> {
    const meter = this.start(task, options);
    try {
      const result = await call(meter.options);
      meter.done(null);
      return result;
    } catch (error) {
      meter.done(error);
      throw error;
    }
  }

  /** Starts timing a call: its options report usage here, and `done` records the Receipt. */
  private start(task: AiTask, options: AiCallOptions | undefined) {
    const at = this.clock.now();
    const started = performance.now();
    let usage: CallUsage | null = null;
    let recorded = false;
    return {
      options: {
        ...options,
        onUsage: (reported: CallUsage) => {
          usage = addUsage(usage, reported);
          options?.onUsage?.(reported);
        },
      } satisfies AiCallOptions,
      done: (error: unknown) => {
        if (recorded) return;
        recorded = true;
        try {
          this.sink.record({
            task,
            at,
            latencyMs: performance.now() - started,
            success: error === null,
            error: error === null ? null : receiptError(error, [options?.model?.provider?.apiKey]),
            usage,
            model: options?.model,
            prompt: options?.prompt,
            language: options?.language,
            link: options?.receipt,
          });
        } catch {
          // A Receipt never fails the call.
        }
      },
    };
  }

  async *chat(input: Parameters<AiPort['chat']>[0], options?: AiCallOptions) {
    const meter = this.start('chat', options);
    let failure: unknown = null;
    try {
      yield* this.engine.chat(input, meter.options) as AsyncIterable<ChatChunk>;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // A reply stopped by the person ends here too: it failed, with that reason.
      meter.done(failure ?? (input.signal?.aborted ? new Error('Stopped by the person') : null));
    }
  }

  countTokens(input: Parameters<AiPort['countTokens']>[0], options?: AiCallOptions) {
    return this.engine.countTokens(input, options);
  }

  summarizeConversation(
    input: Parameters<AiPort['summarizeConversation']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('summarizeConversation', options, (o) =>
      this.engine.summarizeConversation(input, o),
    );
  }

  generateChoices(input: Parameters<AiPort['generateChoices']>[0], options?: AiCallOptions) {
    return this.run('generateChoices', options, (o) => this.engine.generateChoices(input, o));
  }

  draftSpecProposal(input: Parameters<AiPort['draftSpecProposal']>[0], options?: AiCallOptions) {
    return this.run('draftSpecProposal', options, (o) => this.engine.draftSpecProposal(input, o));
  }

  summarizeAttachment(
    input: Parameters<AiPort['summarizeAttachment']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('summarizeAttachment', options, (o) =>
      this.engine.summarizeAttachment(input, o),
    );
  }

  draftSpecFromAttachments(
    input: Parameters<AiPort['draftSpecFromAttachments']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('draftSpecFromAttachments', options, (o) =>
      this.engine.draftSpecFromAttachments(input, o),
    );
  }

  grillingQuestions(input: Parameters<AiPort['grillingQuestions']>[0], options?: AiCallOptions) {
    return this.run('grillingQuestions', options, (o) => this.engine.grillingQuestions(input, o));
  }

  grillingFollowUp(input: Parameters<AiPort['grillingFollowUp']>[0], options?: AiCallOptions) {
    return this.run('grillingFollowUp', options, (o) => this.engine.grillingFollowUp(input, o));
  }

  draftBriefFromGrilling(
    input: Parameters<AiPort['draftBriefFromGrilling']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('draftBriefFromGrilling', options, (o) =>
      this.engine.draftBriefFromGrilling(input, o),
    );
  }

  suggestFeatures(input: Parameters<AiPort['suggestFeatures']>[0], options?: AiCallOptions) {
    return this.run('suggestFeatures', options, (o) => this.engine.suggestFeatures(input, o));
  }

  draftSpecFromSuggestion(
    input: Parameters<AiPort['draftSpecFromSuggestion']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('draftSpecFromSuggestion', options, (o) =>
      this.engine.draftSpecFromSuggestion(input, o),
    );
  }

  checkFeatureFit(input: Parameters<AiPort['checkFeatureFit']>[0], options?: AiCallOptions) {
    return this.run('checkFeatureFit', options, (o) => this.engine.checkFeatureFit(input, o));
  }

  redraftChoices(input: Parameters<AiPort['redraftChoices']>[0], options?: AiCallOptions) {
    return this.run('redraftChoices', options, (o) => this.engine.redraftChoices(input, o));
  }

  redraftSpecProposal(
    input: Parameters<AiPort['redraftSpecProposal']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('redraftSpecProposal', options, (o) =>
      this.engine.redraftSpecProposal(input, o),
    );
  }

  redraftBriefProposal(
    input: Parameters<AiPort['redraftBriefProposal']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('redraftBriefProposal', options, (o) =>
      this.engine.redraftBriefProposal(input, o),
    );
  }

  redraftFeatureSuggestion(
    input: Parameters<AiPort['redraftFeatureSuggestion']>[0],
    options?: AiCallOptions,
  ) {
    return this.run('redraftFeatureSuggestion', options, (o) =>
      this.engine.redraftFeatureSuggestion(input, o),
    );
  }
}
