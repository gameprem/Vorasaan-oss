import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODEL, loadAiConfig } from './ai.config.ts';
import {
  AiOutputError,
  AttachmentSummary,
  BriefDraft,
  type ChatChunk,
  ConversationSummaryDraft,
  FeatureFitDraft,
  FeatureSuggestionDrafts,
  GeneratedChoices,
  GrillingQuestionDrafts,
  SpecProposalDraft,
} from './ai.port.ts';
import { FakeAiPort } from './fake-ai.port.ts';
import { generateStructured, type StructuredGenerate } from './structured.ts';

const valid = {
  suggestedRole: 'PO',
  choices: ['A', 'B'].map((label) => ({
    label,
    title: `Option ${label}`,
    description: 'd',
    impactScope: 's',
    impactTime: 't',
    impactRisk: 'r',
  })),
};

function stub(responses: unknown[]): StructuredGenerate & { count: number } {
  const fn = Object.assign(
    async () => {
      const next = responses[fn.count++];
      if (next instanceof Error) throw next;
      return next;
    },
    { count: 0 },
  );
  return fn;
}

describe('generateStructured', () => {
  test('returns valid output on the first try', async () => {
    const generate = stub([valid]);
    expect(await generateStructured(generate, 't', 'p', GeneratedChoices)).toEqual(valid as never);
    expect(generate.count).toBe(1);
  });

  test('retries once on invalid output', async () => {
    const generate = stub([{ choices: [] }, valid]);
    expect((await generateStructured(generate, 't', 'p', GeneratedChoices)).choices).toHaveLength(
      2,
    );
    expect(generate.count).toBe(2);
  });

  test('retries once on a thrown error', async () => {
    const generate = stub([new Error('rate limited'), valid]);
    await generateStructured(generate, 't', 'p', GeneratedChoices);
    expect(generate.count).toBe(2);
  });

  test('gives up after two invalid results', async () => {
    const generate = stub([{ nope: true }, { still: 'no' }, valid]);
    await expect(
      generateStructured(generate, 'generate-choices', 'p', GeneratedChoices),
    ).rejects.toThrow(AiOutputError);
  });
});

describe('loadAiConfig', () => {
  test('defaults every task to Claude Opus 5.5', () => {
    expect(loadAiConfig({})).toEqual({
      generateChoicesModel: 'anthropic/claude-opus-5-5',
      draftSpecProposalModel: 'anthropic/claude-opus-5-5',
      summarizeAttachmentModel: 'anthropic/claude-opus-5-5',
      draftSpecFromAttachmentsModel: 'anthropic/claude-opus-5-5',
      grillingQuestionsModel: 'anthropic/claude-opus-5-5',
      draftBriefFromGrillingModel: 'anthropic/claude-opus-5-5',
      suggestFeaturesModel: 'anthropic/claude-opus-5-5',
      draftSpecFromSuggestionModel: 'anthropic/claude-opus-5-5',
      checkFeatureFitModel: 'anthropic/claude-opus-5-5',
      chatModel: DEFAULT_MODEL,
      summarizeConversationModel: DEFAULT_MODEL,
    });
  });

  test('model is configurable globally and per task', () => {
    expect(
      loadAiConfig({
        VORASAAN_MODEL: 'openai/some-model',
        VORASAAN_MODEL_GENERATE_CHOICES: 'anthropic/claude-haiku-4-5',
        VORASAAN_MODEL_SUMMARIZE_ATTACHMENT: 'anthropic/claude-haiku-4-5',
      }),
    ).toEqual({
      generateChoicesModel: 'anthropic/claude-haiku-4-5',
      draftSpecProposalModel: 'openai/some-model',
      summarizeAttachmentModel: 'anthropic/claude-haiku-4-5',
      draftSpecFromAttachmentsModel: 'openai/some-model',
      grillingQuestionsModel: 'openai/some-model',
      draftBriefFromGrillingModel: 'openai/some-model',
      suggestFeaturesModel: 'openai/some-model',
      draftSpecFromSuggestionModel: 'openai/some-model',
      checkFeatureFitModel: 'openai/some-model',
      chatModel: 'openai/some-model',
      summarizeConversationModel: 'openai/some-model',
    });
  });
});

describe('FakeAiPort', () => {
  test('produces output that satisfies the real schemas', async () => {
    const ai = new FakeAiPort();
    const result = await ai.generateChoices({
      specMarkdown: '# Spec',
      request: { kind: 'BLOCKER', title: 'Slow API', description: 'd', raiserRole: 'BACKEND' },
      context: [],
    });
    expect(GeneratedChoices.safeParse(result).success).toBe(true);

    const attachment = { title: 'API docs', source: 'URL' as const, text: 'Polling only.' };
    const summary = await ai.summarizeAttachment({ attachment });
    expect(AttachmentSummary.safeParse(summary).success).toBe(true);
    const draft = await ai.draftSpecFromAttachments({
      feature: { title: 'Checkout', description: '' },
      specMarkdown: '',
      context: [
        {
          source: { kind: 'ATTACHMENT', id: 'a1', title: attachment.title },
          scope: 'FEATURE',
          text: attachment.text,
        },
      ],
    });
    expect(SpecProposalDraft.safeParse(draft).success).toBe(true);

    for (const round of ['BUSINESS', 'UX', 'TECHNICAL'] as const) {
      const questions = await ai.grillingQuestions({
        project: { name: 'Mobile Banking' },
        round,
        role: 'PO',
        projectContext: [],
        guidelines: [],
        memory: { rounds: [] },
      });
      expect(GrillingQuestionDrafts.safeParse(questions).success).toBe(true);
      expect(questions.questions.length).toBeGreaterThanOrEqual(3);
    }
    const brief = await ai.draftBriefFromGrilling({
      project: { name: 'Mobile Banking' },
      briefMarkdown: '',
      projectContext: [],
      guidelines: [],
      memory: { rounds: [] },
      answers: [{ round: 'BUSINESS', question: 'Goals?', answer: 'Grow payments.' }],
    });
    expect(BriefDraft.safeParse(brief).success).toBe(true);

    const guidelines = [
      { ref: 'G1', title: 'Serves a KPI', description: '', kind: 'KPI' as const, required: true },
      { ref: 'G2', title: 'PCI', description: '', kind: 'CONSTRAINT' as const, required: true },
    ];
    const suggestions = await ai.suggestFeatures({
      project: { name: 'Mobile Banking' },
      count: 3,
      projectContext: [],
      guidelines,
      decisions: [],
      dismissed: [{ title: 'Suggested Feature 1', rationale: 'r', reason: 'No.' }],
      pending: [],
    });
    expect(FeatureSuggestionDrafts.safeParse(suggestions).success).toBe(true);
    expect(suggestions.suggestions.map((s) => s.title)).toEqual([
      'Suggested Feature 2',
      'Suggested Feature 3',
      'Suggested Feature 4',
    ]);
    const suggestion = suggestions.suggestions[0];
    if (!suggestion) throw new Error('expected a suggestion');
    const first = await ai.draftSpecFromSuggestion({
      project: { name: 'Mobile Banking' },
      suggestion,
      projectContext: [],
      guidelines,
    });
    expect(SpecProposalDraft.safeParse(first).success).toBe(true);
    const fit = await ai.checkFeatureFit({
      project: { name: 'Mobile Banking' },
      feature: { title: 'Card freeze', description: 'Serves a KPI.' },
      projectContext: [],
      guidelines,
    });
    expect(FeatureFitDraft.safeParse(fit).success).toBe(true);

    const summary2 = await ai.summarizeConversation({
      scope: { kind: 'PROJECT', project: { name: 'Mobile Banking' } },
      summary: 'They want card controls.',
      messages: [{ role: 'USER', content: 'And limits?' }],
    });
    expect(ConversationSummaryDraft.safeParse(summary2).success).toBe(true);
    expect(summary2.summary).toBe('They want card controls.\nUSER: And limits?');
  });

  const chatInput = {
    scope: {
      kind: 'FEATURE',
      project: { name: 'Mobile Banking' },
      feature: { title: 'Card freeze', description: '' },
    },
    context: [],
    foundation: { brief: null, guidelines: [] },
    summary: '',
    recentMessages: [{ role: 'USER', content: 'What is left to decide?' }],
    tools: [],
  } as const satisfies Parameters<FakeAiPort['chat']>[0];

  async function collect(stream: AsyncIterable<ChatChunk>) {
    const chunks: ChatChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  test('chat streams the same reply for the same input, word by word', async () => {
    const ai = new FakeAiPort();
    const first = await collect(ai.chat(chatInput));
    const second = await collect(ai.chat(chatInput));
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(3);
    const text = first.map((c) => (c.type === 'text' ? c.delta : '')).join('');
    expect(text).toBe(
      'About the Feature "Card freeze": you said "What is left to decide?". I read 0 context blocks.',
    );
  });

  test('chat can be scripted to call a tool, or to fail mid-reply', async () => {
    const ai = new FakeAiPort();
    const call = { id: 'call-1', name: 'draftSpecProposal', args: { summary: 'Add limits' } };
    ai.scriptChat(
      {
        chunks: [
          { type: 'text', delta: 'Drafting.' },
          { type: 'tool-call', call },
        ],
      },
      { chunks: [{ type: 'text', delta: 'Half a' }], error: new Error('provider down') },
    );
    expect(await collect(ai.chat(chatInput))).toEqual([
      { type: 'text', delta: 'Drafting.' },
      { type: 'tool-call', call },
    ]);
    const seen: ChatChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of ai.chat(chatInput)) seen.push(chunk);
      })(),
    ).rejects.toThrow('provider down');
    expect(seen).toEqual([{ type: 'text', delta: 'Half a' }]);
    // The script is used up: back to the default reply.
    expect((await collect(ai.chat(chatInput)))[0]).toEqual({ type: 'text', delta: 'About ' });
  });
});
