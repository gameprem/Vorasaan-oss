import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import { chatToolsFor } from '../action-cards/chat-tools.ts';
import { AGENT_SKILL_TOOLS } from '../agent-skills/agent-skill-tools.ts';
import { type FakeGemini, startFakeGemini } from '../test/fake-gemini.ts';
import {
  AttachmentSummary,
  BriefDraft,
  type CallUsage,
  type ChatChunk,
  type ContextBlock,
  ConversationFoldDraft,
  DesignDocDraft,
  FeatureFitDraft,
  FeatureSuggestionDrafts,
  FeedbackAnalysis,
  GeneratedChoices,
  GrillingFollowUpDecision,
  GrillingQuestionDrafts,
  type GuidelineForAi,
  ProposedPromptVersion,
  RedraftedChoices,
  RedraftedMarkdown,
  RedraftedPromptVersion,
  RedraftedSuggestion,
  type RequestForAi,
  SpecProposalDraft,
} from './ai.port.ts';
import {
  GEMINI_DEFAULT_URL,
  geminiBaseUrl,
  geminiContextWindow,
  isTextModel,
  listGeminiModels,
} from './gemini.ts';
import { agentGenerate, MastraAiPort, pingModel } from './mastra-ai.port.ts';
import { toMastraModel } from './model-config.ts';
import { chatPrompt, generateChoicesPrompt } from './prompts.ts';

// Ticket 0080: Gemini through MastraAiPort, against a local stand-in for the Gemini
// API. No cache marks (Gemini caches a repeated prefix by itself), the key only in the
// x-goog-api-key header, cached tokens read into the usage, structured output and
// tool calls in the schema subset Gemini accepts.

// Keys unique to this file: Mastra keeps model instances per key, URL included.
const KEY = 'AIza-gemini-test-key-0080-calls';

const CHOICES = {
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

const guidelines: GuidelineForAi[] = [
  { title: 'Serves a KPI', description: 'Names the KPI it moves.', kind: 'KPI', required: true },
];
const foundation = {
  brief: { version: 3, markdown: `# Brief\n${'Mobile banking for small shops. '.repeat(40)}` },
  guidelines,
};
const SPEC = `# Card freeze\n${'A customer can freeze a card from the app. '.repeat(30)}`;
const request: RequestForAi = {
  kind: 'BLOCKER',
  title: 'No webhook from the card processor',
  description: 'Polling only.',
  raiserRole: 'BACKEND',
};
const context: ContextBlock[] = [
  {
    source: { kind: 'DECISION', id: 'd1', title: 'Poll every 5s' },
    scope: 'FEATURE',
    text: 'Decided to poll.',
  },
];
const choicesInput = { specMarkdown: SPEC, request, context, foundation };

const chatInput = {
  scope: {
    kind: 'FEATURE' as const,
    project: { name: 'Mobile Banking' },
    feature: { title: 'Card freeze', description: '' },
  },
  context: [
    {
      source: { kind: 'SPEC_VERSION' as const, id: 's1', title: 'Spec: Card freeze', version: 2 },
      scope: 'FEATURE' as const,
      text: SPEC,
    },
    ...context,
  ],
  foundation,
  summary: '## Goal\n- Freeze cards',
  recentMessages: [
    { role: 'USER' as const, content: 'What about timeouts?' },
    { role: 'ASSISTANT' as const, content: 'We poll every 5s.' },
    { role: 'USER' as const, content: 'And retries?' },
  ],
  tools: [],
};

async function collect(stream: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

type Part = { text?: string; functionCall?: unknown; thoughtSignature?: string };
type Content = { role: string; parts: Part[] };

const textOf = (c: { parts: Part[] } | undefined) => (c?.parts ?? []).map((p) => p.text).join('');

/** The fields of Gemini's Schema object (an OpenAPI 3.0 subset): nothing else is accepted. */
const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
]);

/** Every field of a schema Gemini would refuse, with its path. */
function unsupportedFields(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_FIELDS.has(key)) found.push(`${path}.${key}`);
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        found.push(...unsupportedFields(child, `${path}.properties.${name}`));
      }
    } else if (key === 'items') {
      found.push(...unsupportedFields(value, `${path}.items`));
    } else if (key === 'anyOf' && Array.isArray(value)) {
      value.forEach((v, i) => {
        found.push(...unsupportedFields(v, `${path}.anyOf[${i}]`));
      });
    }
  }
  return found;
}

describe('Gemini calls', () => {
  let fake: FakeGemini;
  let previousUrl: string | undefined;
  const model = (id: string, apiKey = KEY) =>
    toMastraModel({ provider: 'GEMINI', model: id, apiKey, baseUrl: null });
  const port = (id: string, apiKey = KEY) => new MastraAiPort(async () => model(id, apiKey));

  beforeAll(() => {
    fake = startFakeGemini(KEY);
    previousUrl = process.env.GOOGLE_BASE_URL;
    process.env.GOOGLE_BASE_URL = fake.url;
  });

  afterAll(() => {
    if (previousUrl === undefined) delete process.env.GOOGLE_BASE_URL;
    else process.env.GOOGLE_BASE_URL = previousUrl;
    fake.stop();
  });

  test("a Gemini model routes through Mastra's Google provider with the key, never a URL", () => {
    expect(model('gemini-example-pro')).toEqual({ id: 'google/gemini-example-pro', apiKey: KEY });
  });

  test('a task: the whole prompt unmarked, structured output, and the cached tokens in the usage', async () => {
    fake.requests.length = 0;
    fake.functionCall = null;
    fake.structured = CHOICES;
    const usages: CallUsage[] = [];
    const log = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      expect(
        await port('gemini-example-pro').generateChoices(choicesInput, {
          onUsage: (u) => usages.push(u),
        }),
      ).toEqual(CHOICES as never);
      // Gemini's cachedContentTokenCount (implicit caching), logged and on the Receipt.
      expect(log).toHaveBeenCalledWith(
        // Thinking tokens bill as output: 12 written + 30 thought.
        'generate-choices: input 2410 (cache read 1980, cache write ?), output 42 (reasoning 30)',
      );
    } finally {
      log.mockRestore();
    }
    expect(usages).toEqual([
      {
        inputTokens: 2410,
        outputTokens: 42,
        cacheReadTokens: 1980,
        cacheWriteTokens: null,
        reasoningTokens: 30,
      },
    ]);
    const [call] = fake.requests;
    expect(call?.path).toBe('/v1beta/models/gemini-example-pro:streamGenerateContent');
    const contents = call?.body?.contents as Content[];
    expect(contents.map((c) => c.role)).toEqual(['user']);
    const prompt = await generateChoicesPrompt(SPEC, request, context, foundation);
    expect(textOf(contents[0])).toBe(prompt.text);
    // No explicit cache: Gemini's implicit caching needs only the stable-first order.
    expect(call?.body?.cachedContent).toBeUndefined();
    expect(JSON.stringify(call?.body)).not.toMatch(/cache_?control/i);
    const config = call?.body?.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');
    expect(unsupportedFields(config.responseSchema)).toEqual([]);
  });

  test('a chat: the system prompt as one instruction, the history as user and model turns', async () => {
    fake.requests.length = 0;
    fake.functionCall = null;
    const chunks = await collect(port('gemini-example-pro').chat(chatInput));
    expect(chunks).toEqual([
      { type: 'text', delta: 'Retry three times.' },
      { type: 'usage', usage: { inputTokens: 2410, cacheReadTokens: 1980 } },
    ]);
    const body = fake.requests[0]?.body;
    const system = body?.systemInstruction as { parts: Part[] };
    expect(textOf(system)).toBe((await chatPrompt(chatInput)).text);
    expect(((body?.contents ?? []) as Content[]).map((c) => c.role)).toEqual([
      'user',
      'model',
      'user',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/cache_?control/i);
  });

  test('chat tools: declared in the schema subset Gemini accepts, and a call comes back as a tool call', async () => {
    fake.requests.length = 0;
    fake.functionCall = { name: 'searchContext', args: { query: 'timeouts' } };
    try {
      const tools = chatToolsFor({ featureId: 'f1' });
      const chunks = await collect(port('gemini-example-pro').chat({ ...chatInput, tools }));
      expect(chunks[0]).toEqual({
        type: 'tool-call',
        call: { id: expect.any(String), name: 'searchContext', args: { query: 'timeouts' } },
      });
      const declared = (
        (fake.requests[0]?.body?.tools ?? []) as { functionDeclarations: { name: string }[] }[]
      ).flatMap((t) => t.functionDeclarations);
      expect(declared.map((d) => d.name)).toEqual(tools.map((t) => t.name));
    } finally {
      fake.functionCall = null;
    }
  });

  test('a replayed tool call carries a thought signature, which Gemini 3 models require', async () => {
    fake.requests.length = 0;
    const tools = chatToolsFor({ featureId: 'f1' });
    await collect(
      port('gemini-3-example-pro').chat({
        ...chatInput,
        tools,
        recentMessages: [
          { role: 'USER', content: 'What about timeouts?' },
          {
            role: 'ASSISTANT',
            content: '',
            toolCalls: [{ id: 'c1', name: 'searchContext', args: { query: 'timeouts' } }],
          },
          { role: 'TOOL', toolCallId: 'c1', content: '{"ok":true,"blocks":[]}' },
        ],
      }),
    );
    const contents = fake.requests[0]?.body?.contents as Content[];
    const call = contents.flatMap((c) => c.parts).find((p) => p.functionCall);
    expect(call?.functionCall).toMatchObject({ name: 'searchContext' });
    // Vorasaan stores no signature; the Google provider sends Gemini's documented
    // placeholder for a call it did not sign, instead of a 400.
    expect(call?.thoughtSignature).toBe('skip_thought_signature_validator');
  });

  test('every task schema and chat tool is sent with only fields Gemini accepts', async () => {
    const schemas: [string, z.ZodType][] = [
      ['GeneratedChoices', GeneratedChoices],
      ['SpecProposalDraft', SpecProposalDraft],
      ['AttachmentSummary', AttachmentSummary],
      ['GrillingQuestionDrafts', GrillingQuestionDrafts],
      ['GrillingFollowUpDecision', GrillingFollowUpDecision],
      ['BriefDraft', BriefDraft],
      ['FeatureSuggestionDrafts', FeatureSuggestionDrafts],
      ['FeatureFitDraft', FeatureFitDraft],
      ['RedraftedChoices', RedraftedChoices],
      ['RedraftedMarkdown', RedraftedMarkdown],
      ['RedraftedSuggestion', RedraftedSuggestion],
      ['FeedbackAnalysis', FeedbackAnalysis],
      ['ProposedPromptVersion', ProposedPromptVersion],
      ['RedraftedPromptVersion', RedraftedPromptVersion],
      ['DesignDocDraft', DesignDocDraft],
      ['ConversationFoldDraft', ConversationFoldDraft],
    ];
    fake.structured = {};
    const sent: Record<string, unknown>[] = [];
    // The stand-in's answer won't match every schema (Mastra logs that): only the request matters here.
    const quiet = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(console, level).mockImplementation(() => {}),
    );
    const usageLog = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      for (const [name, schema] of schemas) {
        fake.requests.length = 0;
        await agentGenerate(name, model('gemini-example-pro'))('Draft it.', schema).catch(() => {});
        sent.push(fake.requests[0]?.body?.generationConfig as Record<string, unknown>);
      }
      // Mastra logs the last failed validation just after the call settles.
      await Bun.sleep(50);
    } finally {
      for (const spy of [...quiet, usageLog]) spy.mockRestore();
    }
    for (const [i, [name]] of schemas.entries()) {
      const config = sent[i] as Record<string, unknown>;
      expect({ name, schema: Boolean(config?.responseSchema) }).toEqual({ name, schema: true });
      expect({ name, unsupported: unsupportedFields(config.responseSchema) }).toEqual({
        name,
        unsupported: [],
      });
    }

    fake.requests.length = 0;
    const tools = [
      ...chatToolsFor({ featureId: 'f1' }),
      ...chatToolsFor({ featureId: null }),
      ...AGENT_SKILL_TOOLS,
    ];
    await collect(port('gemini-example-pro').chat({ ...chatInput, tools }));
    const declared = (
      (fake.requests[0]?.body?.tools ?? []) as {
        functionDeclarations: { name: string; parameters: unknown }[];
      }[]
    ).flatMap((t) => t.functionDeclarations);
    expect(declared.length).toBe(new Set(tools.map((t) => t.name)).size);
    for (const d of declared) {
      expect({ name: d.name, unsupported: unsupportedFields(d.parameters) }).toEqual({
        name: d.name,
        unsupported: [],
      });
    }
  });

  test('thinking at each call’s default level: a task, a chat and the connection test', async () => {
    fake.requests.length = 0;
    fake.functionCall = null;
    fake.structured = CHOICES;
    const quiet = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      await port('gemini-3-example-flash').generateChoices(choicesInput);
      await collect(port('gemini-3-example-flash').chat(chatInput));
      fake.structured = { reply: 'ok' };
      await pingModel(model('gemini-3-example-flash'));
      // Gemini 2.5 takes a budget instead: off on Flash, Pro's least (128) on Pro.
      await pingModel(model('gemini-2.5-flash'));
      await pingModel(model('gemini-2.5-pro'));
    } finally {
      quiet.mockRestore();
    }
    const thinking = fake.requests.map(
      (r) => (r.body?.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig,
    );
    // Ticket 0081: a structured task defaults to LOW, chat to MEDIUM, the connection test LOW.
    expect(thinking).toEqual([
      { thinkingLevel: 'low' },
      { thinkingLevel: 'medium' },
      { thinkingLevel: 'low' },
      { thinkingBudget: 0 },
      { thinkingBudget: 128 },
    ]);
  });

  test('a Gemma model gets no thinking settings, which it would refuse', async () => {
    fake.requests.length = 0;
    fake.structured = { reply: 'ok' };
    const quiet = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      await pingModel(model('gemma-example-27b-it'));
      await collect(port('gemma-example-27b-it').chat(chatInput));
    } finally {
      quiet.mockRestore();
    }
    expect(fake.requests).toHaveLength(2);
    for (const r of fake.requests) {
      expect(JSON.stringify(r.body)).not.toContain('thinking');
    }
  });

  test('VORASAAN_GEMINI_THINKING=default sends nothing, high asks for the most', async () => {
    const previous = process.env.VORASAAN_GEMINI_THINKING;
    fake.structured = { reply: 'ok' };
    const quiet = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      fake.requests.length = 0;
      process.env.VORASAAN_GEMINI_THINKING = 'default';
      await pingModel(model('gemini-3-example-flash'));
      expect(JSON.stringify(fake.requests[0]?.body)).not.toContain('thinking');
      fake.requests.length = 0;
      process.env.VORASAAN_GEMINI_THINKING = 'high';
      await pingModel(model('gemini-3-example-flash'));
      const config = fake.requests[0]?.body?.generationConfig as Record<string, unknown>;
      expect(config.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    } finally {
      quiet.mockRestore();
      if (previous === undefined) delete process.env.VORASAAN_GEMINI_THINKING;
      else process.env.VORASAAN_GEMINI_THINKING = previous;
    }
  });

  test('the key travels only in the x-goog-api-key header', () => {
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      expect(r.headers['x-goog-api-key']).toBe(KEY);
      expect(r.search).not.toContain(KEY);
      expect(JSON.stringify(r.body)).not.toContain(KEY);
    }
  });

  test('token counting is the estimate, with no call to Gemini', async () => {
    fake.requests.length = 0;
    const counted = await new MastraAiPort().countTokens(
      { system: 'You help.', messages: [{ role: 'USER', content: 'Hello there' }] },
      {
        model: {
          source: 'APPROVED_MODEL',
          approvedModelId: 'm1',
          integrationId: 'i1',
          provider: { provider: 'GEMINI', model: 'gemini-example-pro', apiKey: KEY, baseUrl: null },
          name: 'gemini-example-pro',
          contextWindow: 1_048_576,
        },
      },
    );
    expect(counted).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(0);
  });

  test('test connection succeeds, and reports the error otherwise with the key masked', async () => {
    fake.structured = { reply: 'ok' };
    await pingModel(model('gemini-example-pro'));
    const wrongKey = 'AIza-wrong-key-for-the-fake-0080';
    // Mastra logs the provider's error with its body, which echoes the key: masked.
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : Bun.inspect(a))).join(' '));
      }),
    );
    try {
      await expect(pingModel(model('gemini-example-pro', wrongKey))).rejects.toThrow(
        'API key not valid',
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).toContain('API key not valid: …');
    expect(logged.join('\n')).not.toContain(wrongKey);
  });
});

describe("Gemini's model list", () => {
  let fake: FakeGemini;
  const LIST_KEY = 'AIza-gemini-test-key-0080-list';
  const env = () => ({ GOOGLE_BASE_URL: fake.url });

  beforeAll(() => {
    fake = startFakeGemini(LIST_KEY);
  });

  afterAll(() => fake.stop());

  test('lists the text models by name with their input token limit, across pages, the key in a header', async () => {
    fake.requests.length = 0;
    fake.modelsStatus = null;
    fake.pageSize = 2;
    fake.models = [
      {
        name: 'models/gemini-example-pro',
        displayName: 'Gemini Example Pro',
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      },
      {
        name: 'models/example-embedding',
        displayName: 'Example Embedding',
        inputTokenLimit: 2_048,
        supportedGenerationMethods: ['embedContent'],
      },
      {
        name: 'models/gemini-example-flash',
        displayName: 'Gemini Example Flash',
        inputTokenLimit: 1_048_576,
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-example-tiny',
        displayName: 'Gemini Example Tiny',
        inputTokenLimit: 1_024,
        supportedGenerationMethods: ['generateContent'],
      },
      { name: 'models/gemini-example-unnamed', inputTokenLimit: null },
    ];
    const list = await listGeminiModels(LIST_KEY, env());
    expect(list).toEqual({
      models: [
        { id: 'gemini-example-flash', name: 'Gemini Example Flash', contextWindow: 1_048_576 },
        { id: 'gemini-example-pro', name: 'Gemini Example Pro', contextWindow: 1_048_576 },
        { id: 'gemini-example-tiny', name: 'Gemini Example Tiny', contextWindow: null },
        { id: 'gemini-example-unnamed', name: 'gemini-example-unnamed', contextWindow: null },
      ],
      error: null,
    });
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/v1beta/models',
      '/v1beta/models',
      '/v1beta/models',
    ]);
    for (const r of fake.requests) {
      expect(r.headers['x-goog-api-key']).toBe(LIST_KEY);
      expect(r.search).not.toContain(LIST_KEY);
    }
    expect(await geminiContextWindow('gemini-example-pro', LIST_KEY, env())).toBe(1_048_576);
    expect(await geminiContextWindow('models/gemini-example-pro', LIST_KEY, env())).toBe(1_048_576);
    expect(await geminiContextWindow('gemini-missing', LIST_KEY, env())).toBeNull();
    fake.pageSize = 50;
  });

  test('leaves out the models that answer generateContent but write no text for a chat', () => {
    // Ids from Google's real list for a new key.
    for (const id of [
      'gemini-flash-latest',
      'gemini-pro-latest',
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview-customtools',
      'gemma-4-31b-it',
    ]) {
      expect(isTextModel(id)).toBe(true);
    }
    for (const id of [
      'gemini-3.8-flash-tts',
      'gemini-2.5-flash-preview-tts',
      'gemini-3.1-flash-image',
      'gemini-3-pro-image-preview',
      'nano-banana-pro-preview',
      'lyria-3.5',
      'gemini-3.5-transcribe',
      'gemini-robotics-er-2-preview',
      'gemini-2.5-computer-use-preview-10-2025',
      'deep-research-pro-preview-12-2025',
      'antigravity-preview-latest',
      'gemini-embedding-001',
    ]) {
      expect(isTextModel(id)).toBe(false);
    }
  });

  test('a list that cannot be loaded is an error that never carries the key, never a throw', async () => {
    const refused = await listGeminiModels('AIza-refused-list-key-0080', env());
    expect(refused).toEqual({
      models: [],
      error: 'The Gemini API refused the key (400) when listing its models',
    });
    fake.modelsStatus = 503;
    expect(await listGeminiModels(LIST_KEY, env())).toEqual({
      models: [],
      error: 'The Gemini API answered 503 for its model list',
    });
    fake.modelsStatus = null;
    const unreachable = await listGeminiModels(LIST_KEY, {
      GOOGLE_BASE_URL: 'http://127.0.0.1:9/v1beta',
    });
    expect(unreachable.models).toEqual([]);
    expect(unreachable.error).toStartWith("Could not load the Gemini API's model list");
    expect(unreachable.error).not.toContain(LIST_KEY);
  });
});

describe('Gemini settings from env', () => {
  test('the base URL is fixed unless the operator overrides it with an http(s) URL', () => {
    expect(geminiBaseUrl({})).toBe(GEMINI_DEFAULT_URL);
    expect(GEMINI_DEFAULT_URL).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(geminiBaseUrl({ GOOGLE_BASE_URL: 'http://localhost:1234/v1beta/' })).toBe(
      'http://localhost:1234/v1beta',
    );
    expect(geminiBaseUrl({ GOOGLE_BASE_URL: 'file:///etc/passwd' })).toBe(GEMINI_DEFAULT_URL);
    expect(geminiBaseUrl({ GOOGLE_BASE_URL: 'not a url' })).toBe(GEMINI_DEFAULT_URL);
  });
});
