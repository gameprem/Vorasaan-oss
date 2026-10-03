import type { AiTask } from './ai.config.ts';
import type { AiCallOptions, AiPort, ChatChunk, ModelChoice } from './ai.port.ts';

/** Picks the model of one call: the caller's pick, else the task's, else the default. */
export type ModelChooser = (task: AiTask, approvedModelId?: string) => Promise<ModelChoice>;

/**
 * The AiPort the services use. Before each call it chooses the model (ADR 0010)
 * and hands it to the adapter that talks to the provider (MastraAiPort), or to
 * the FakeAiPort in tests, which records it. The choice is made on every call,
 * so a change in Settings applies to the next one.
 */
export class ModelRoutingAiPort implements AiPort {
  constructor(
    private readonly engine: AiPort,
    private readonly choose: ModelChooser,
  ) {}

  /**
   * A caller that already chose the model (`options.model`, e.g. a Conversation's
   * turn, which chooses once for all its steps and records it) keeps it.
   */
  private async options(task: AiTask, options?: AiCallOptions): Promise<AiCallOptions> {
    if (options?.model) return options;
    return { ...options, model: await this.choose(task, options?.approvedModelId) };
  }

  async *chat(input: Parameters<AiPort['chat']>[0], options?: AiCallOptions) {
    // Chosen once, before the first chunk: a reply never switches model midway.
    const chosen = await this.options('chat', options);
    yield* this.engine.chat(input, chosen) as AsyncIterable<ChatChunk>;
  }

  async summarizeConversation(
    input: Parameters<AiPort['summarizeConversation']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.summarizeConversation(
      input,
      await this.options('summarizeConversation', options),
    );
  }

  /** Counts on the caller's model (a Conversation's turn passes it); else the chat model. */
  async countTokens(input: Parameters<AiPort['countTokens']>[0], options?: AiCallOptions) {
    return this.engine.countTokens(input, await this.options('chat', options));
  }

  async generateChoices(input: Parameters<AiPort['generateChoices']>[0], options?: AiCallOptions) {
    return this.engine.generateChoices(input, await this.options('generateChoices', options));
  }

  async draftSpecProposal(
    input: Parameters<AiPort['draftSpecProposal']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.draftSpecProposal(input, await this.options('draftSpecProposal', options));
  }

  async summarizeAttachment(
    input: Parameters<AiPort['summarizeAttachment']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.summarizeAttachment(
      input,
      await this.options('summarizeAttachment', options),
    );
  }

  async draftSpecFromAttachments(
    input: Parameters<AiPort['draftSpecFromAttachments']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.draftSpecFromAttachments(
      input,
      await this.options('draftSpecFromAttachments', options),
    );
  }

  async grillingQuestions(
    input: Parameters<AiPort['grillingQuestions']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.grillingQuestions(input, await this.options('grillingQuestions', options));
  }

  async grillingFollowUp(
    input: Parameters<AiPort['grillingFollowUp']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.grillingFollowUp(input, await this.options('grillingFollowUp', options));
  }

  async draftBriefFromGrilling(
    input: Parameters<AiPort['draftBriefFromGrilling']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.draftBriefFromGrilling(
      input,
      await this.options('draftBriefFromGrilling', options),
    );
  }

  async suggestFeatures(input: Parameters<AiPort['suggestFeatures']>[0], options?: AiCallOptions) {
    return this.engine.suggestFeatures(input, await this.options('suggestFeatures', options));
  }

  async draftSpecFromSuggestion(
    input: Parameters<AiPort['draftSpecFromSuggestion']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.draftSpecFromSuggestion(
      input,
      await this.options('draftSpecFromSuggestion', options),
    );
  }

  async checkFeatureFit(input: Parameters<AiPort['checkFeatureFit']>[0], options?: AiCallOptions) {
    return this.engine.checkFeatureFit(input, await this.options('checkFeatureFit', options));
  }

  async redraftChoices(input: Parameters<AiPort['redraftChoices']>[0], options?: AiCallOptions) {
    return this.engine.redraftChoices(input, await this.options('redraftChoices', options));
  }

  async redraftSpecProposal(
    input: Parameters<AiPort['redraftSpecProposal']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.redraftSpecProposal(
      input,
      await this.options('redraftSpecProposal', options),
    );
  }

  async redraftBriefProposal(
    input: Parameters<AiPort['redraftBriefProposal']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.redraftBriefProposal(
      input,
      await this.options('redraftBriefProposal', options),
    );
  }

  async redraftFeatureSuggestion(
    input: Parameters<AiPort['redraftFeatureSuggestion']>[0],
    options?: AiCallOptions,
  ) {
    return this.engine.redraftFeatureSuggestion(
      input,
      await this.options('redraftFeatureSuggestion', options),
    );
  }
}
