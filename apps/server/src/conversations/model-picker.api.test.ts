import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, SEED_SPEC_V1, seed } from '@vorasaan/db/seed';
import type {
  ActionCardView,
  AiModelsView,
  AiProviderView,
  ApprovedModelSettingsView,
  BriefVersionView,
  ConversationTurnView,
  ConversationView,
  DecideResult,
  DecisionLogEntry,
  RecordedModel,
  ServerEvent,
  SpecVersionView,
} from '@vorasaan/shared';
import type { ChatChunk } from '../ai/ai.port.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

// The model picker in chat (ticket 0054, ADR 0010): a Conversation runs on the
// Approved Model picked in it, every reply records the model that wrote it, and
// proposals drafted from Action Cards record the model that drafted them.

const { pim, beam } = SEED.users;

const NEW_SPEC = `${SEED_SPEC_V1.trimEnd()}\n\n## Timeouts\n- Treat a payment as failed after 24 hours.\n`;

const text = (delta: string): ChatChunk => ({ type: 'text', delta });
const call = (id: string, name: string, args: unknown): ChatChunk => ({
  type: 'tool-call',
  call: { id, name, args },
});

describe('The model picker in chat (0054)', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let bus: EventBus;
  let events: ServerEvent[];
  let unsubscribe: () => void;
  /** "Best" is the default; "Fast" is the other Approved Model. */
  let best: ApprovedModelSettingsView;
  let fast: ApprovedModelSettingsView;

  const asPim = () => as(app, pim.id);
  const feature = { kind: 'FEATURE', featureId: SEED.featureId };
  const project = { kind: 'PROJECT', projectId: SEED.projectId };
  const chatModels = () =>
    ai.calls.filter((c) => c.method === 'chat').map((c) => c.model?.approvedModelId ?? null);
  const recorded = (m: ApprovedModelSettingsView): RecordedModel => ({
    approvedModelId: m.id,
    displayName: m.displayName,
    modelId: m.modelId,
  });

  function start(content: string, extra: object = {}, scope: object = feature) {
    return asPim()<ConversationView>('POST', '/conversations', { scope, content, ...extra });
  }
  function send(id: string, content: string, extra: object = {}) {
    return asPim()<ConversationTurnView>('POST', `/conversations/${id}/messages`, {
      content,
      ...extra,
    });
  }
  async function read(id: string) {
    const res = await asPim()<ConversationView>('GET', `/conversations/${id}`);
    expect(res.status).toBe(200);
    return res.body;
  }
  const replies = (c: ConversationView) =>
    c.messages.filter((m) => m.role === 'ASSISTANT' && !m.toolCalls?.length);

  async function removeModel(id: string) {
    expect((await asPim()('DELETE', `/settings/ai/models/${id}`)).status).toBe(204);
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    ai = testApp.ai;
    db = createTestPrisma();
    bus = app.get(EventBus);
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    ai.calls.length = 0;
    ai.chatScript.length = 0;
    events = [];
    unsubscribe = bus.subscribe(pim.id, (event) => events.push(event));

    // Pim is an Admin: one provider, "Best" (the default) and "Fast".
    const provider = await asPim()<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'ANTHROPIC',
      name: 'Anthropic',
      apiKey: 'sk-ant-test-1234',
    });
    expect(provider.status).toBe(201);
    const approve = async (modelId: string, displayName: string, note: string) => {
      const res = await asPim()<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
        providerId: provider.body.id,
        modelId,
        displayName,
        note,
      });
      expect(res.status).toBe(201);
      return res.body;
    };
    best = await approve('model-best', 'Best', 'Specs, Choices and hard calls');
    fast = await approve('model-fast', 'Fast', 'Quick answers');
  });

  afterEach(() => {
    unsubscribe();
    delete process.env.VORASAAN_MODEL_CHAT;
  });

  test('GET /ai/models names the chat default for every member', async () => {
    const res = await as(app, beam.id)<AiModelsView>('GET', '/ai/models');
    expect(res.status).toBe(200);
    expect(res.body.chatDefaultId).toBe(best.id);
    expect(res.body.models.map((m) => [m.displayName, m.note, m.isDefault])).toEqual([
      ['Best', 'Specs, Choices and hard calls', true],
      ['Fast', 'Quick answers', false],
    ]);

    // The model set for chat in Settings is the chat default.
    await asPim()('PUT', '/settings/ai/tasks', { tasks: { CHAT: fast.id } });
    expect((await as(app, beam.id)<AiModelsView>('GET', '/ai/models')).body.chatDefaultId).toBe(
      fast.id,
    );
  });

  test('a new Conversation runs on the default, and its reply records the model that wrote it', async () => {
    const res = await start('What does the Spec say about retries?');
    expect(res.status).toBe(201);
    expect(res.body.modelId).toBeNull();
    expect(chatModels()).toEqual([best.id]);
    const [reply] = replies(res.body);
    expect(reply?.model).toEqual(recorded(best));
    expect(reply?.modelNotice).toBeNull();
    // The person's own message records no model.
    expect(res.body.messages[0]?.model).toBeNull();
  });

  test('switching the model mid-Conversation sends the next turn to the new model; earlier messages keep theirs', async () => {
    const started = await start('First question');
    const id = started.body.id;

    const switched = await send(id, 'Second question', { approvedModelId: fast.id });
    expect(switched.status).toBe(201);
    expect(switched.body.conversation.modelId).toBe(fast.id);
    expect(switched.body.reply.model).toEqual(recorded(fast));
    expect(chatModels()).toEqual([best.id, fast.id]);

    // The Conversation keeps its model for the messages after, without asking again.
    const kept = await send(id, 'Third question');
    expect(kept.body.reply.model?.displayName).toBe('Fast');
    expect(chatModels()).toEqual([best.id, fast.id, fast.id]);

    // Earlier replies keep the model that wrote them, even once it is renamed.
    await asPim()('PATCH', `/settings/ai/models/${best.id}`, { displayName: 'Strongest' });
    const conversation = await read(id);
    expect(conversation.modelId).toBe(fast.id);
    expect(replies(conversation).map((m) => m.model?.displayName)).toEqual([
      'Best',
      'Fast',
      'Fast',
    ]);
  });

  test('a model picked when starting is used from the first reply', async () => {
    const res = await start('Quick one', { approvedModelId: fast.id });
    expect(res.status).toBe(201);
    expect(res.body.modelId).toBe(fast.id);
    expect(replies(res.body)[0]?.model).toEqual(recorded(fast));
    expect(chatModels()).toEqual([fast.id]);
  });

  test('a model that is not an Approved Model is a 422, and nothing is stored', async () => {
    const started = await start('Hello');
    const id = started.body.id;
    const unknown = '00000000-0000-4000-8000-000000000000';

    const refused = await send(id, 'Use another model', { approvedModelId: unknown });
    expect(refused.status).toBe(422);
    expect((await read(id)).messages).toHaveLength(2);

    const before = await db.conversation.count();
    expect((await start('New one', { approvedModelId: unknown })).status).toBe(422);
    expect(await db.conversation.count()).toBe(before);
    expect(chatModels()).toEqual([best.id]);
  });

  test('a removed model falls back to the default on the next message, and that reply says so once', async () => {
    const started = await start('Hello', { approvedModelId: fast.id });
    const id = started.body.id;
    await removeModel(fast.id);

    // The Conversation no longer points at it …
    expect((await read(id)).modelId).toBeNull();
    // … so the next reply runs on the default and says why.
    const next = await send(id, 'Still there?');
    expect(next.status).toBe(201);
    expect(next.body.reply.model).toEqual(recorded(best));
    expect(next.body.reply.modelNotice).toBe('Fast was removed, so this reply used Best.');
    expect(chatModels()).toEqual([fast.id, best.id]);

    // Only once.
    const after = await send(id, 'And now?');
    expect(after.body.reply.modelNotice).toBeNull();

    // The first reply still shows the model that wrote it.
    expect(replies(await read(id)).map((m) => [m.model?.displayName, m.modelNotice])).toEqual([
      ['Fast', null],
      ['Best', 'Fast was removed, so this reply used Best.'],
      ['Best', null],
    ]);
  });

  test('picking another model after one was removed needs no notice', async () => {
    const started = await start('Hello', { approvedModelId: fast.id });
    await removeModel(fast.id);
    const next = await send(started.body.id, 'Hi', { approvedModelId: best.id });
    expect(next.body.reply.model?.displayName).toBe('Best');
    expect(next.body.reply.modelNotice).toBeNull();
  });

  test('nothing switches model in the middle of a reply, even when the model is removed meanwhile', async () => {
    const started = await start('Hello', { approvedModelId: fast.id });
    const id = started.body.id;
    ai.calls.length = 0;
    ai.scriptChat(
      {
        chunks: [
          text('I '),
          text('will '),
          text('draft '),
          text('it. '),
          call('call-1', 'draftSpecProposal', {
            proposedMarkdown: NEW_SPEC,
            summary: 'Adds a 24-hour payment timeout.',
          }),
        ],
        chunkDelayMs: 40,
      },
      { chunks: [text('Ready '), text('to '), text('approve.')], chunkDelayMs: 40 },
    );
    events.length = 0;
    const turn = send(id, 'Add a 24 hour timeout');
    // Once the reply is being written, an Admin removes its model.
    while (!events.some((e) => e.event === 'conversation.delta')) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await removeModel(fast.id);

    const res = await turn;
    expect(res.status).toBe(201);
    // Both steps of the turn ran on Fast, and both messages record it.
    expect(chatModels()).toEqual([fast.id, fast.id]);
    expect(res.body.steps[0]?.model?.displayName).toBe('Fast');
    expect(res.body.reply.model?.displayName).toBe('Fast');
    expect(res.body.reply.modelNotice).toBeNull();

    // The next message is the first one on the default.
    const next = await send(id, 'Thanks');
    expect(next.body.reply.model?.displayName).toBe('Best');
    expect(next.body.reply.modelNotice).toBe('Fast was removed, so this reply used Best.');
  });

  test('a Spec Proposal drafted from an Action Card records its model, and the Spec history shows it', async () => {
    ai.scriptChat(
      {
        chunks: [
          call('call-1', 'draftSpecProposal', {
            proposedMarkdown: NEW_SPEC,
            summary: 'Adds a 24-hour payment timeout.',
          }),
        ],
      },
      { chunks: [text('The draft is ready.')] },
    );
    const res = await start('Add a 24 hour timeout', { approvedModelId: fast.id });
    const card = res.body.actionCards[0] as ActionCardView;
    const proposal = await db.specProposal.findUniqueOrThrow({ where: { id: card.targetId } });
    expect(proposal).toMatchObject({
      approvedModelId: fast.id,
      modelDisplayName: 'Fast',
      modelName: 'model-fast',
    });

    expect((await asPim()('POST', `/action-cards/${card.id}/approve`)).status).toBe(201);
    // Removing the model later doesn't change the history.
    await removeModel(fast.id);
    const versions = await asPim()<SpecVersionView[]>(
      'GET',
      `/features/${SEED.featureId}/spec-versions`,
    );
    const latest = versions.body.reduce((a, v) => (v.version > a.version ? v : a));
    expect(latest.draftedWith).toEqual(recorded(fast));
    expect(versions.body.find((v) => v.version === 1)?.draftedWith).toBeNull();
  });

  test('a Brief Proposal drafted from an Action Card records its model, and the Brief history shows it', async () => {
    ai.scriptChat(
      {
        chunks: [
          call('b1', 'draftBriefProposal', {
            proposedMarkdown: '# Project Brief\n\nRetail banking.\n',
            summary: 'First Brief.',
          }),
        ],
      },
      { chunks: [text('Drafted.')] },
    );
    const res = await start('Draft our Project Brief', {}, project);
    const card = res.body.actionCards[0] as ActionCardView;
    expect((await asPim()('POST', `/action-cards/${card.id}/approve`)).status).toBe(201);
    const versions = await asPim()<BriefVersionView[]>(
      'GET',
      `/projects/${SEED.projectId}/brief-versions`,
    );
    expect(versions.body[0]?.draftedWith).toEqual(recorded(best));
  });

  test("a Decision Request drafted from an Action Card gets its AI Choices from the Conversation's model, and the Decision Log shows it", async () => {
    ai.scriptChat(
      {
        chunks: [
          call('call-1', 'draftDecisionRequest', {
            kind: 'BLOCKER',
            title: 'Provider has no webhook',
            description: 'Only polling is available. How long do we poll?',
          }),
        ],
      },
      { chunks: [text('Review the Choices and send it.')] },
    );
    const started = await as(app, beam.id)<ConversationView>('POST', '/conversations', {
      scope: feature,
      content: 'I am blocked: the provider has no webhook',
      approvedModelId: fast.id,
    });
    expect(started.status).toBe(201);
    const card = started.body.actionCards[0] as ActionCardView;
    const choices = ai.calls.find((c) => c.method === 'generateChoices');
    expect(choices?.model?.approvedModelId).toBe(fast.id);

    // Beam sends it to the PO; Pim decides.
    expect((await as(app, beam.id)('POST', `/action-cards/${card.id}/approve`)).status).toBe(201);
    const request = await db.decisionRequest.findUniqueOrThrow({
      where: { id: card.targetId },
      include: { choices: { orderBy: { position: 'asc' } } },
    });
    expect(request).toMatchObject({
      choicesApprovedModelId: fast.id,
      choicesModelDisplayName: 'Fast',
      choicesModelName: 'model-fast',
    });
    const decided = await asPim()<DecideResult>(
      'POST',
      `/decision-requests/${request.id}/decision`,
      {
        choiceId: request.choices[0]?.id,
      },
    );
    expect(decided.status).toBe(201);
    const log = await asPim()<DecisionLogEntry[]>(
      'GET',
      `/features/${SEED.featureId}/decision-log`,
    );
    expect(log.body.find((e) => e.decisionRequestId === request.id)?.choicesDraftedWith).toEqual(
      recorded(fast),
    );
  });

  test('a Decision Request raised from the form records no chat model', async () => {
    const raised = await as(app, beam.id)<{ id: string }>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Which provider?',
      description: 'We need to pick one.',
    });
    expect(raised.status).toBe(201);
    const request = await db.decisionRequest.findUniqueOrThrow({ where: { id: raised.body.id } });
    expect(request.choicesApprovedModelId).toBeNull();
  });

  test('with VORASAAN_MODEL_CHAT set, a Conversation with no pick runs on it and says so; a picked model still wins', async () => {
    process.env.VORASAAN_MODEL_CHAT = 'openai/env-chat-model';
    expect((await asPim()<AiModelsView>('GET', '/ai/models')).body.chatDefaultId).toBeNull();

    const started = await start('Which model?');
    const [reply] = replies(started.body);
    expect(reply?.model).toEqual({
      approvedModelId: null,
      displayName: null,
      modelId: 'openai/env-chat-model',
    });

    const picked = await send(started.body.id, 'Now on Fast', { approvedModelId: fast.id });
    expect(picked.body.reply.model).toEqual(recorded(fast));
    expect(ai.calls.filter((c) => c.method === 'chat').map((c) => c.model?.source)).toEqual([
      'ENV',
      'APPROVED_MODEL',
    ]);
  });

  test('retry after a failed reply uses the Conversation’s model', async () => {
    const started = await start('Hello', { approvedModelId: fast.id });
    ai.scriptChat({ chunks: [text('Half')], error: new Error('provider down') });
    const failed = await send(started.body.id, 'Again');
    expect(failed.status).toBe(502);
    const retried = await asPim()<ConversationTurnView>(
      'POST',
      `/conversations/${started.body.id}/retry`,
    );
    expect(retried.status).toBe(201);
    expect(retried.body.reply.model?.displayName).toBe('Fast');
    expect(chatModels()).toEqual([fast.id, fast.id, fast.id]);
  });
});
