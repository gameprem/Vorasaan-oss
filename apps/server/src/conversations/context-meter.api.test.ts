import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiProviderView,
  ApprovedModelSettingsView,
  CompactConversationResult,
  ConversationCompactionSummary,
  ConversationTurnView,
  ConversationUsage,
  ConversationView,
  ServerEvent,
} from '@vorasaan/shared';
import { chatToolsFor } from '../action-cards/chat-tools.ts';
import type { ChatMessageForAi, RecordForAi } from '../ai/ai.port.ts';
import { BUDGET_CONFIG, planBudget, toolTokens } from '../ai/context-budget.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { skillTokens } from '../ai/prompts.ts';
import { estimateChatTokens } from '../ai/token-count.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

// The context meter and manual compaction (ticket 0066, ADR 0012): the server sends how
// full a Conversation is from its own budget plan, and a person compacts it with a say
// in what the Conversation Summary keeps.

const { pim, beam } = SEED.users;

type SummarizeInput = {
  summary: string;
  messages: ChatMessageForAi[];
  focus?: string | null;
  record?: RecordForAi | null;
};

describe('The context meter and /compact (0066)', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let events: ServerEvent[];
  let unsubscribe: () => void;
  let small: ApprovedModelSettingsView;
  let large: ApprovedModelSettingsView;

  const asPim = () => as(app, pim.id);
  const summarizeCalls = () =>
    ai.calls
      .filter((c) => c.method === 'summarizeConversation')
      .map((c) => c.input as SummarizeInput);

  async function start(content: string, model = large, user: string = pim.id) {
    const res = await as(app, user)<ConversationView>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content,
      approvedModelId: model.id,
    });
    expect(res.status).toBe(201);
    return res.body;
  }
  async function send(id: string, content: string, user: string = pim.id) {
    const res = await as(app, user)<ConversationTurnView>('POST', `/conversations/${id}/messages`, {
      content,
    });
    expect(res.status).toBe(201);
    return res.body;
  }
  function compact(id: string, body: object = {}, user: string = pim.id) {
    return as(app, user)<CompactConversationResult>('POST', `/conversations/${id}/compact`, body);
  }

  /** What the server plans a Feature turn's system prompt at: instructions, tools, slack. */
  async function featureSystem() {
    return (
      BUDGET_CONFIG.promptSlack +
      (await skillTokens('chat')) +
      toolTokens(chatToolsFor({ featureId: SEED.featureId }))
    );
  }

  /** The history as the fake counts it: the summary and every message after it. */
  async function historyTokens(id: string) {
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id } });
    const rows = await db.conversationMessage.findMany({
      where: { conversationId: id, position: { gte: conversation.summarizedThrough } },
      orderBy: { position: 'asc' },
    });
    const messages = rows.map((m): ChatMessageForAi => {
      if (m.role === 'TOOL')
        return { role: 'TOOL', content: m.content, toolCallId: m.toolCallId ?? '' };
      return { role: m.role, content: m.content } as ChatMessageForAi;
    });
    return estimateChatTokens({ system: conversation.summary, messages });
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    ai = testApp.ai;
    db = createTestPrisma();
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
    ai.tokenCounts.length = 0;
    ai.tokenScale = 1;
    ai.cacheReadTokens = 0;
    events = [];
    unsubscribe?.();
    unsubscribe = app.get(EventBus).subscribe(pim.id, (event) => events.push(event));

    const provider = await asPim()<AiProviderView>('POST', '/settings/ai/providers', {
      kind: 'OPENAI_COMPATIBLE',
      name: 'Local',
      baseUrl: 'http://localhost:20128/v1',
      apiKey: 'local-key-1234',
    });
    expect(provider.status).toBe(201);
    const approve = async (modelId: string, displayName: string, contextWindow: number) => {
      const res = await asPim()<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
        providerId: provider.body.id,
        modelId,
        displayName,
        contextWindow,
      });
      expect(res.status).toBe(201);
      return res.body;
    };
    large = await approve('local-large', 'Large', 200_000);
    small = await approve('local-small', 'Small', 8_000);
  });

  test("a turn's usage matches the server's budget plan for its model's window", async () => {
    ai.cacheReadTokens = 1_200;
    const conversation = await start('How do we handle a payment timeout?');
    const turn = await send(conversation.id, 'And what does support see?');
    const usage = turn.usage as ConversationUsage;
    expect(usage).not.toBeNull();
    expect(usage.conversationId).toBe(conversation.id);
    expect(usage.model).toEqual({
      approvedModelId: large.id,
      displayName: 'Large',
      modelId: 'local-large',
    });
    expect(usage.contextWindow).toBe(200_000);

    const system = await featureSystem();
    const { window: _, ...plan } = planBudget(200_000, 'conversationFeature', { system });
    expect(usage.plan).toEqual(plan);
    expect(usage.history.share).toBe(plan.history);
    expect(usage.history.compactAt).toBe(Math.floor(BUDGET_CONFIG.compaction.at * plan.history));
    expect(usage.history.warnAt).toBeLessThan(usage.history.compactAt);
    expect(usage.history.used).toBe(await historyTokens(conversation.id));
    expect(usage.history.fraction).toBeCloseTo(usage.history.used / plan.history, 6);
    // The last turn's cache reads, as the provider reported them (0061).
    expect(usage.lastTurn?.cacheReadTokens).toBe(1_200);
    expect(usage.lastTurn?.inputTokens).toBeGreaterThan(1_200);

    // The same numbers go out on the event stream, and come back on load.
    const sent = events.filter((e) => e.event === 'conversation.usage');
    expect(sent.at(-1)?.data).toEqual({ conversationId: conversation.id, usage });
    const loaded = await asPim()<ConversationUsage>(
      'GET',
      `/conversations/${conversation.id}/usage`,
    );
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual(usage);
  });

  test('switching to a model with a smaller window returns usage for that window', async () => {
    const conversation = await start('How do we handle a payment timeout?');
    const res = await asPim()<ConversationUsage>(
      'GET',
      `/conversations/${conversation.id}/usage?approvedModelId=${small.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.contextWindow).toBe(8_000);
    expect(res.body.model.approvedModelId).toBe(small.id);
    const { window: _, ...plan } = planBudget(8_000, 'conversationFeature', {
      system: await featureSystem(),
    });
    expect(res.body.plan).toEqual(plan);
    expect(res.body.history.share).toBe(plan.history);
    // The smaller share is fuller for the same history.
    const onLarge = await asPim()<ConversationUsage>(
      'GET',
      `/conversations/${conversation.id}/usage`,
    );
    expect(onLarge.body.contextWindow).toBe(200_000);
    expect(res.body.history.fraction).toBeGreaterThan(onLarge.body.history.fraction);
    // Picking only asks: the Conversation keeps its model.
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).modelId,
    ).toBe(large.id);
    // Not an Approved Model: 422.
    const unknown = await asPim()(
      'GET',
      `/conversations/${conversation.id}/usage?approvedModelId=${SEED.featureId}`,
    );
    expect(unknown.status).toBe(422);
    expect((await as(app, beam.id)('GET', `/conversations/${conversation.id}/usage`)).status).toBe(
      404,
    );
  });

  test('/compact keep the limits folds the history, passes the focus to the summarizer, and stores it', async () => {
    // Long messages, so the summary costs less than what it folds.
    const notes = ' Notes from the provider call follow in detail'.repeat(60);
    const conversation = await start(
      `What are the payment limits? PAY-142 has the details.${notes}`,
    );
    await send(conversation.id, `The daily limit is 1.5M baht per merchant\n${notes}`);
    const last = await send(conversation.id, 'Now the refund flow');
    const before = (
      await asPim()<ConversationUsage>('GET', `/conversations/${conversation.id}/usage`)
    ).body;

    const res = await compact(conversation.id, { focus: 'keep the limits' });
    expect(res.status).toBe(201);
    if (res.body.status !== 'COMPACTED')
      throw new Error(`expected COMPACTED, got ${res.body.status}`);
    // Everything before the last turn is folded; the last turn stays word for word.
    expect(res.body.conversation.summarizedThrough).toBe(last.message.position);
    expect(res.body.compaction).toMatchObject({
      number: 1,
      trigger: 'MANUAL',
      focus: 'keep the limits',
      summarizedThrough: last.message.position,
      beforeMessageId: last.message.id,
      createdBy: { id: pim.id },
    });
    expect(res.body.usage.history.used).toBeLessThan(before.history.used);

    const calls = summarizeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.focus).toBe('keep the limits');
    expect(calls[0]?.messages.map((m) => m.content).join('\n')).toContain(
      'The daily limit is 1.5M baht per merchant',
    );

    const stored = await db.conversationCompaction.findFirstOrThrow({
      where: { conversationId: conversation.id },
    });
    expect(stored).toMatchObject({
      trigger: 'MANUAL',
      focus: 'keep the limits',
      createdById: pim.id,
    });
    expect(events.some((e) => e.event === 'conversation.compacted')).toBe(true);
    expect(events.filter((e) => e.event === 'conversation.usage').at(-1)?.data.usage).toEqual(
      res.body.usage,
    );

    // The view lists it for its divider, and "View summary" reads the summary as it left it.
    const view = await asPim()<ConversationView>('GET', `/conversations/${conversation.id}`);
    expect(view.body.compactions).toEqual([res.body.compaction]);
    const summary = await asPim()<ConversationCompactionSummary>(
      'GET',
      `/conversations/${conversation.id}/compactions/${res.body.compaction.id}`,
    );
    expect(summary.status).toBe(200);
    expect(summary.body.current).toBe(true);
    expect(summary.body.summary).toBe(stored.summary);
    expect(summary.body.sections.map((s) => s.heading)).toContain('Agreed');
    expect(summary.body.sections.find((s) => s.heading === 'Preferences')?.items).toContain(
      'Keep: keep the limits',
    );
    expect(summary.body.summary).toContain('PAY-142');

    // The messages above the divider are all still there.
    expect(view.body.messages.map((m) => m.content).join('\n')).toContain(
      'The daily limit is 1.5M baht per merchant',
    );
    // A second compaction gets its own divider; the first one's summary stays as it was.
    await send(conversation.id, 'And chargebacks?');
    const again = await compact(conversation.id);
    expect(again.body.status).toBe('COMPACTED');
    const both = await asPim()<ConversationView>('GET', `/conversations/${conversation.id}`);
    expect(both.body.compactions.map((c) => c.number)).toEqual([1, 2]);
    const first = await asPim()<ConversationCompactionSummary>(
      'GET',
      `/conversations/${conversation.id}/compactions/${res.body.compaction.id}`,
    );
    expect(first.body.current).toBe(false);
    expect(first.body.summary).toBe(stored.summary);
  });

  test('compacting with an agreed point that is not in the Spec offers an Action Card first', async () => {
    const conversation = await start('How many retries for a failed payment?');
    await send(conversation.id, 'We agreed on 5 retries, 30 seconds apart');
    await send(conversation.id, 'Next: the receipt email');

    const res = await compact(conversation.id, { focus: 'retries' });
    expect(res.status).toBe(201);
    if (res.body.status !== 'RECORD_FIRST')
      throw new Error(`expected RECORD_FIRST, got ${res.body.status}`);
    expect(res.body.unrecorded).toEqual(['We agreed on 5 retries, 30 seconds apart']);
    expect(res.body.card).toMatchObject({ kind: 'SPEC_PROPOSAL', status: 'PROPOSED' });
    // The card hangs on the AI's message, which says why it offers it.
    const [offer, result] = res.body.messages;
    expect(offer?.role).toBe('ASSISTANT');
    expect(offer?.content).toContain('We agreed on 5 retries, 30 seconds apart');
    expect(offer?.toolCalls?.[0]?.name).toBe('draftSpecProposal');
    expect(result?.role).toBe('TOOL');
    expect(res.body.card.messageId).toBe(offer?.id ?? '');
    // The proposal adds the point to the Spec; nothing is folded yet.
    const proposal = await db.specProposal.findUniqueOrThrow({
      where: { id: res.body.card.targetId },
    });
    expect(proposal.proposedMarkdown).toContain('We agreed on 5 retries, 30 seconds apart');
    const unchanged = await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(unchanged.summarizedThrough).toBe(0);
    expect(await db.conversationCompaction.count()).toBe(0);
    // The fold was checked against the Spec as it is.
    expect(summarizeCalls()[0]?.record?.kind).toBe('SPEC');

    // Once the person acts on it (or skips it), compaction goes on.
    const approved = await asPim()('POST', `/action-cards/${res.body.card.id}/approve`, {});
    expect(approved.status).toBe(201);
    const done = await compact(conversation.id, { focus: 'retries', skipRecordCheck: true });
    expect(done.body.status).toBe('COMPACTED');
    expect(summarizeCalls().at(-1)?.record ?? null).toBeNull();
    // With the point in the Spec now, a later check offers nothing.
    await send(conversation.id, 'Fine');
    const later = await compact(conversation.id);
    expect(later.body.status).toBe('COMPACTED');
  });

  test('someone who may not change the Spec gets no card: compaction goes straight on', async () => {
    const conversation = await start('How many retries?', large, beam.id);
    await send(conversation.id, 'We agreed on 5 retries', beam.id);
    await send(conversation.id, 'Next topic', beam.id);
    const res = await compact(conversation.id, {}, beam.id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('COMPACTED');
    expect(await db.actionCard.count()).toBe(0);
    // The offer that could not become a card left no message behind.
    const roles = await db.conversationMessage.findMany({
      where: { conversationId: conversation.id },
      select: { role: true },
    });
    expect(roles.map((r) => r.role)).toEqual([
      'USER',
      'ASSISTANT',
      'USER',
      'ASSISTANT',
      'USER',
      'ASSISTANT',
    ]);
  });

  test('nothing to compact is a 409; another person gets a 404', async () => {
    const conversation = await start('Just one question');
    expect((await compact(conversation.id)).status).toBe(409);
    expect((await compact(conversation.id, {}, beam.id)).status).toBe(404);
    expect(summarizeCalls()).toHaveLength(0);
  });

  test('an automatic compaction is recorded with its own divider', async () => {
    ai.tokenScale = 40;
    const conversation = await start('First question about the payment flow', small);
    await send(conversation.id, 'Second question about the refunds');
    const turn = await send(conversation.id, 'Third question about the receipts');
    expect(turn.conversation.summarizedThrough).toBeGreaterThan(0);
    const compactions = await db.conversationCompaction.findMany({
      where: { conversationId: conversation.id },
    });
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0]).toMatchObject({ trigger: 'AUTO', focus: null, createdById: null });
    const sent = events.filter((e) => e.event === 'conversation.compacted');
    expect(sent.length).toBe(compactions.length);
  });
});
