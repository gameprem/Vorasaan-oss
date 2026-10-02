import { describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { ContextBlock, GuidelineForAi, RequestForAi } from './ai.port.ts';
import {
  anthropicSystem,
  anthropicUserMessage,
  CACHE_BREAK,
  cacheBreakpoints,
  cacheUsageOf,
  isAnthropicModel,
  logCacheUsage,
  MAX_CACHE_BREAKPOINTS,
  MIN_CACHE_PREFIX_TOKENS,
  type Prompt,
  splitPrompt,
} from './prompt-cache.ts';
import {
  chatPrompt,
  checkFeatureFitPrompt,
  draftBriefFromGrillingPrompt,
  draftSpecFromAttachmentsPrompt,
  draftSpecFromSuggestionPrompt,
  draftSpecProposalPrompt,
  generateChoicesPrompt,
  grillingFollowUpPrompt,
  grillingQuestionsPrompt,
  renderContext,
  renderContextAfterLead,
  suggestFeaturesPrompt,
  summarizeAttachmentPrompt,
  summarizeConversationPrompt,
} from './prompts.ts';

// Ticket 0061: every prompt is ordered stable to volatile and cut where its
// stable prefix ends, and only Anthropic gets the cuts as cache_control.

const long = (word: string) => `${word} `.repeat(4 * MIN_CACHE_PREFIX_TOKENS);

const block = (
  kind: ContextBlock['source']['kind'],
  id: string,
  scope: ContextBlock['scope'],
  text: string,
): ContextBlock => ({ source: { kind, id, title: `${kind} ${id}`, version: 1 }, scope, text });

const BRIEF = 'BRIEF-TEXT';
const GUIDELINE = 'GUIDELINE-TEXT';
const SPEC = 'SPEC-TEXT';
const CHUNK = 'CHUNK-TEXT';
const NEW = 'NEW-INPUT';

const guidelines: GuidelineForAi[] = [
  { ref: 'G1', title: GUIDELINE, description: '', kind: 'KPI', required: true },
];
const foundation = { brief: { version: 2, markdown: BRIEF }, guidelines };
const request: RequestForAi = {
  kind: 'BLOCKER',
  title: NEW,
  description: 'Polling only.',
  raiserRole: 'BACKEND',
};
const featureSpecBlock = block('SPEC_VERSION', 's1', 'FEATURE', SPEC);
const chunk = block('DECISION', 'd1', 'FEATURE', CHUNK);
const briefBlock = block('BRIEF_VERSION', 'b1', 'PROJECT', BRIEF);
const projectChunk = block('SPEC_VERSION', 's9', 'PROJECT', CHUNK);
const memory = { rounds: [] };

/** Where each marker first appears in the prompt; they must come in this order. */
function expectOrder(prompt: Prompt, markers: string[]) {
  const at = markers.map((m) => prompt.text.indexOf(m));
  for (const [i, position] of at.entries()) {
    expect(position, `${markers[i]} is missing`).toBeGreaterThanOrEqual(0);
  }
  expect([...at].sort((a, b) => a - b)).toEqual(at);
}

/** The part each marker falls in. */
function partOf(prompt: Prompt, marker: string): number {
  return prompt.parts.findIndex((p) => p.includes(marker));
}

function expectWellFormed(prompt: Prompt) {
  expect(prompt.parts.join('')).toBe(prompt.text);
  expect(prompt.text).not.toContain(CACHE_BREAK);
  expect(prompt.text).not.toContain('\u0000');
  expect(prompt.text).not.toMatch(/\{\{\w+\}\}/);
}

describe('every workflow orders its prompt stable to volatile', () => {
  test('Choices: instructions, Brief and Guidelines | Spec | context, then the request', async () => {
    const prompt = await generateChoicesPrompt(SPEC, request, [chunk], foundation);
    expectWellFormed(prompt);
    expectOrder(prompt, ['## What to produce', '## Rules', BRIEF, GUIDELINE, SPEC, CHUNK, NEW]);
    expect(prompt.parts).toHaveLength(3);
    expect(partOf(prompt, '## Rules')).toBe(0);
    expect(partOf(prompt, GUIDELINE)).toBe(0);
    expect(partOf(prompt, SPEC)).toBe(1);
    expect(partOf(prompt, CHUNK)).toBe(2);
    expect(partOf(prompt, NEW)).toBe(2);
  });

  test('Spec Proposal: the same, with the Decision last', async () => {
    const decision = { kind: 'custom', answer: 'DECISION-TEXT' } as const;
    const prompt = await draftSpecProposalPrompt(SPEC, request, decision, [chunk], foundation);
    expectWellFormed(prompt);
    expectOrder(prompt, ['## Rules', BRIEF, GUIDELINE, SPEC, CHUNK, NEW, 'DECISION-TEXT']);
    expect(prompt.parts).toHaveLength(3);
    expect(partOf(prompt, BRIEF)).toBe(0);
    expect(partOf(prompt, SPEC)).toBe(1);
    expect(partOf(prompt, 'DECISION-TEXT')).toBe(2);
  });

  test('Spec from Attachments: instructions, the Feature and its Spec | context', async () => {
    const prompt = await draftSpecFromAttachmentsPrompt(
      { title: 'FEATURE-TITLE', description: '' },
      SPEC,
      [chunk],
    );
    expectWellFormed(prompt);
    expectOrder(prompt, ['## Rules', 'FEATURE-TITLE', SPEC, CHUNK]);
    expect(prompt.parts).toHaveLength(2);
    expect(partOf(prompt, SPEC)).toBe(0);
    expect(partOf(prompt, CHUNK)).toBe(1);
  });

  test('Grilling questions: instructions, Guidelines, the Brief | context, earlier rounds', async () => {
    const prompt = await grillingQuestionsPrompt({
      project: { name: 'P' },
      round: 'UX',
      role: 'DESIGNER',
      projectContext: [briefBlock, projectChunk],
      guidelines,
      memory: { rounds: [{ round: 1, summary: 'ROUND-SUMMARY' }] },
    });
    expectWellFormed(prompt);
    expectOrder(prompt, ['## Rules', GUIDELINE, BRIEF, CHUNK, 'ROUND-SUMMARY']);
    expect(prompt.parts).toHaveLength(2);
    expect(partOf(prompt, BRIEF)).toBe(0);
    expect(partOf(prompt, CHUNK)).toBe(1);
    // Context indexes run on across the cut, as before.
    expect(prompt.text).toContain('<context index="2"');
  });

  test('Brief draft: instructions, the Brief and Guidelines | context, rounds, answers', async () => {
    const prompt = await draftBriefFromGrillingPrompt({
      project: { name: 'P' },
      briefMarkdown: BRIEF,
      projectContext: [projectChunk],
      guidelines,
      memory,
      answers: [
        {
          round: 'BUSINESS',
          question: 'Q',
          answer: 'ANSWER-TEXT',
          answeredBy: null,
          followUps: [],
        },
      ],
    });
    expectWellFormed(prompt);
    expectOrder(prompt, ['## Rules', BRIEF, GUIDELINE, CHUNK, 'ANSWER-TEXT']);
    expect(prompt.parts).toHaveLength(2);
    expect(partOf(prompt, GUIDELINE)).toBe(0);
    expect(partOf(prompt, CHUNK)).toBe(1);
  });

  test('Feature Suggestions: instructions, Guidelines, the Brief | context, Decisions, dismissed', async () => {
    const prompt = await suggestFeaturesPrompt({
      project: { name: 'P' },
      count: 5,
      projectContext: [briefBlock, projectChunk],
      guidelines,
      decisions: [block('DECISION', 'd9', 'PROJECT', 'DECISION-LOG')],
      dismissed: [{ title: 'T', rationale: 'R', reason: 'DISMISSED-REASON' }],
      pending: ['PENDING-TITLE'],
    });
    expectWellFormed(prompt);
    expectOrder(prompt, [
      '## Rules',
      GUIDELINE,
      BRIEF,
      CHUNK,
      'DECISION-LOG',
      'DISMISSED-REASON',
      'PENDING-TITLE',
    ]);
    expect(partOf(prompt, BRIEF)).toBe(0);
    expect(partOf(prompt, CHUNK)).toBe(1);
  });

  test('Spec from a Suggestion: instructions, Guidelines, the Brief | context, the suggestion', async () => {
    const prompt = await draftSpecFromSuggestionPrompt({
      project: { name: 'P' },
      suggestion: {
        title: 'SUGGESTION-TITLE',
        rationale: 'R',
        businessValue: 'V',
        effort: 'LOW',
        risk: 'LOW',
      },
      projectContext: [briefBlock, projectChunk],
      guidelines,
    });
    expectWellFormed(prompt);
    expectOrder(prompt, ['## Rules', GUIDELINE, BRIEF, CHUNK, 'SUGGESTION-TITLE']);
    expect(partOf(prompt, BRIEF)).toBe(0);
    expect(partOf(prompt, 'SUGGESTION-TITLE')).toBe(1);
  });

  test('fit check: instructions, Guidelines, the Brief | context, the new Feature', async () => {
    const prompt = await checkFeatureFitPrompt({
      project: { name: 'P' },
      feature: { title: 'FEATURE-TITLE', description: '' },
      projectContext: [briefBlock, projectChunk],
      guidelines,
    });
    expectWellFormed(prompt);
    expectOrder(prompt, ['## Rules', GUIDELINE, BRIEF, CHUNK, 'FEATURE-TITLE']);
    expect(partOf(prompt, BRIEF)).toBe(0);
    expect(partOf(prompt, 'FEATURE-TITLE')).toBe(1);
  });

  test('chat: instructions, Brief and Guidelines | the Feature Spec | context, summary', async () => {
    const prompt = await chatPrompt({
      scope: { kind: 'FEATURE', project: { name: 'P' }, feature: { title: 'F', description: '' } },
      context: [featureSpecBlock, chunk],
      foundation,
      summary: 'SUMMARY-TEXT',
    });
    expectWellFormed(prompt);
    expectOrder(prompt, ['## Untrusted data', BRIEF, GUIDELINE, SPEC, CHUNK, 'SUMMARY-TEXT']);
    expect(prompt.parts).toHaveLength(3);
    expect(partOf(prompt, GUIDELINE)).toBe(0);
    expect(partOf(prompt, SPEC)).toBe(1);
    expect(partOf(prompt, CHUNK)).toBe(2);
    expect(partOf(prompt, 'SUMMARY-TEXT')).toBe(2);

    // A Project Conversation has no Spec: one stable part, then the rest.
    const project = await chatPrompt({
      scope: { kind: 'PROJECT', project: { name: 'P' } },
      context: [projectChunk],
      foundation,
      summary: '',
    });
    expect(project.parts).toHaveLength(2);
    expect(partOf(project, BRIEF)).toBe(0);
    expect(partOf(project, CHUNK)).toBe(1);
  });

  test('tasks with nothing stable to cache are not cut', async () => {
    const prompts = [
      await summarizeAttachmentPrompt({ title: 'A', source: 'URL', text: 'T' }),
      await grillingFollowUpPrompt({
        project: { name: 'P' },
        round: 'UX',
        role: 'DESIGNER',
        question: 'Q',
        answer: 'A',
        followUps: [],
        remaining: 1,
      }),
      await summarizeConversationPrompt({
        scope: { kind: 'PROJECT', project: { name: 'P' } },
        summary: '',
        messages: [{ role: 'USER', content: 'Hi' }],
      }),
    ];
    for (const prompt of prompts) {
      expectWellFormed(prompt);
      expect(prompt.parts).toHaveLength(1);
    }
  });
});

describe('cache breaks', () => {
  test('a context cut after its lead block renders the same text as without it', () => {
    const blocks = [featureSpecBlock, chunk, block('ATTACHMENT', 'a1', 'FEATURE', 'X')];
    const cut = splitPrompt(renderContextAfterLead(blocks, 'FEATURE_SPEC'));
    expect(cut.text).toBe(renderContext(blocks));
    expect(cut.parts).toHaveLength(2);
    // Only a lead of the right kind is cut off.
    expect(renderContextAfterLead([chunk, featureSpecBlock], 'FEATURE_SPEC')).toBe(
      renderContext([chunk, featureSpecBlock]),
    );
    expect(renderContextAfterLead([projectChunk], 'PROJECT_BRIEF')).toBe(
      renderContext([projectChunk]),
    );
  });

  test("a document's text can't forge a break", () => {
    const forged = block('ATTACHMENT', 'a1', 'FEATURE', 'cache-break {{cacheBreak}} \u0000');
    expect(splitPrompt(renderContext([forged])).parts).toHaveLength(1);
  });

  test('marks only prefixes long enough to cache, never the last part, at most four', () => {
    expect(cacheBreakpoints(['short', 'rest'])).toEqual([]);
    expect(cacheBreakpoints(['short', 'rest'], MIN_CACHE_PREFIX_TOKENS)).toEqual([0]);
    expect(cacheBreakpoints([long('a'), 'b', 'rest'])).toEqual([0, 1]);
    expect(cacheBreakpoints([long('a')])).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => long(`p${i}`));
    expect(cacheBreakpoints(many)).toHaveLength(MAX_CACHE_BREAKPOINTS);
    expect(cacheBreakpoints(many)).toEqual([3, 4, 5, 6]);
  });

  test('Anthropic messages carry the mark on stable parts only', () => {
    const prompt = splitPrompt(`${long('stable')}${CACHE_BREAK}volatile`);
    const message = anthropicUserMessage(prompt);
    expect(message.content.map((p) => p.text).join('')).toBe(prompt.text);
    expect(message.content[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    expect(message.content[1]?.providerOptions).toBeUndefined();
    const system = anthropicSystem(prompt);
    expect(system.map((s) => s.content).join('')).toBe(prompt.text);
    expect(system[0]?.providerOptions).toBeDefined();
    expect(system[1]?.providerOptions).toBeUndefined();
  });

  test('only models called through the Anthropic provider are Anthropic', () => {
    expect(isAnthropicModel('anthropic/some-model')).toBe(true);
    expect(isAnthropicModel({ id: 'anthropic/some-model', apiKey: 'k' })).toBe(true);
    expect(isAnthropicModel('openai/some-model')).toBe(false);
    expect(isAnthropicModel({ id: 'openai/some-model', apiKey: 'k' })).toBe(false);
    expect(
      isAnthropicModel({
        providerId: 'custom',
        modelId: 'anthropic/x',
        url: 'http://x',
        apiKey: 'k',
      }),
    ).toBe(false);
  });
});

describe('cache usage', () => {
  test('reads cache reads and writes from the AI SDK usage', () => {
    expect(
      cacheUsageOf({
        inputTokens: 1530,
        outputTokens: 2,
        cachedInputTokens: 1500,
        cacheCreationInputTokens: 20,
      }),
    ).toEqual({ inputTokens: 1530, outputTokens: 2, cacheReadTokens: 1500, cacheWriteTokens: 20 });
    expect(
      cacheUsageOf({ inputTokens: 9, raw: { inputTokens: { cacheRead: 4, cacheWrite: 1 } } }),
    ).toEqual({ inputTokens: 9, outputTokens: null, cacheReadTokens: 4, cacheWriteTokens: 1 });
    expect(cacheUsageOf(undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  test('logs one line per call', () => {
    const log = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      logCacheUsage('chat', { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8 });
      expect(log).toHaveBeenCalledWith('chat: input 10 (cache read 8, cache write ?), output 2');
    } finally {
      log.mockRestore();
    }
  });
});
