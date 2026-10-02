import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AiProviderView,
  ApprovedModelSettingsView,
  ConversationReplyFailed,
  ConversationTurnView,
  ConversationView,
  ServerEvent,
} from '@vorasaan/shared';
import { type ChatMessageForAi, ContextTooLongError } from '../ai/ai.port.ts';
import { planBudget } from '../ai/context-budget.ts';
import { chatPromptTokens, type FakeAiPort } from '../ai/fake-ai.port.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { blockTokens } from '../retrieval/context-retriever.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

// Context budgets from the model, and auto-compaction (ticket 0060, ADR 0012):
// every AI call fits the window of the model it runs on, and a long Conversation
// keeps going without forgetting what was agreed.

const { pim } = SEED.users;

type ChatInput = Parameters<typeof chatPromptTokens>[0];

/** About `chars` Thai characters of Spec-like text, one sentence per line. */
function thai(chars: number, seedWord = ''): string {
  const sentences = [
    'ลูกค้ากดชำระเงินแล้วระบบต้องแสดงสถานะกำลังดำเนินการทันทีโดยไม่ต้องรอผู้ให้บริการ',
    'เมื่อผู้ให้บริการยืนยันการชำระเงินแล้วคำสั่งซื้อจะเปลี่ยนเป็นชำระแล้วและส่งการแจ้งเตือน',
    'หากผู้ให้บริการไม่ตอบกลับภายในเวลาที่กำหนดระบบจะถือว่าการชำระเงินล้มเหลวและคืนสินค้า',
    'ทีมซัพพอร์ตต้องเห็นเหตุผลที่การชำระเงินค้างอยู่ได้จากหน้าจอเดียวโดยไม่ต้องค้นหาเพิ่ม',
  ];
  const lines: string[] = [];
  for (let i = 0; lines.join('\n').length < chars; i++) {
    lines.push(`${seedWord}${sentences[i % sentences.length]}`);
  }
  return lines.join('\n');
}

describe('Context budgets from the model (0060)', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let events: ServerEvent[];
  let unsubscribe: () => void;
  /** An 8,000-token local model and a 200,000-token one, on one provider. */
  let small: ApprovedModelSettingsView;
  let large: ApprovedModelSettingsView;

  const asPim = () => as(app, pim.id);
  const chatCalls = () =>
    ai.calls.filter((c) => c.method === 'chat').map((c) => c.input as ChatInput);
  const summarizeCalls = () =>
    ai.calls
      .filter((c) => c.method === 'summarizeConversation')
      .map((c) => c.input as { summary: string; messages: ChatMessageForAi[] });

  function start(content: string, model: ApprovedModelSettingsView) {
    return asPim()<ConversationView>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content,
      approvedModelId: model.id,
    });
  }
  function send(id: string, content: string) {
    return asPim()<ConversationTurnView>('POST', `/conversations/${id}/messages`, { content });
  }
  /** The chat call's whole prompt plus the reply room planned for it stays within the window. */
  async function expectFits(input: ChatInput, window: number) {
    const reply = planBudget(window, 'conversationFeature').reply;
    expect((await chatPromptTokens(input)) + reply).toBeLessThanOrEqual(window);
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
      expect(res.body.contextWindow).toBe(contextWindow);
      return res.body;
    };
    large = await approve('local-large', 'Large', 200_000);
    small = await approve('local-small', 'Small', 8_000);

    // Plenty of Thai material: a long Brief and eight long Attachments not indexed yet.
    await db.briefVersion.create({
      data: {
        projectId: SEED.projectId,
        version: 1,
        markdown: `# Project Brief\n\n${thai(6_000)}`,
        source: 'MANUAL',
        approvedById: pim.id,
      },
    });
    for (let i = 1; i <= 8; i++) {
      await db.attachment.create({
        data: {
          featureId: SEED.featureId,
          source: 'FILE',
          title: `Provider notes ${i}`,
          snapshotText: thai(3_000, `${i} `),
          snapshotAt: new Date(Date.now() - i * 60_000),
          addedById: pim.id,
        },
      });
    }
  });

  test('an 8k model: a Feature turn fits its window; a 200k model retrieves more context for the same turn', async () => {
    const question = 'How long do we wait for the payment provider?';
    expect((await start(question, small)).status).toBe(201);
    const onSmall = chatCalls().at(-1) as ChatInput;
    await expectFits(onSmall, 8_000);

    expect((await start(question, large)).status).toBe(201);
    const onLarge = chatCalls().at(-1) as ChatInput;
    await expectFits(onLarge, 200_000);

    const contextTokens = (input: ChatInput) =>
      input.context.reduce((sum, b) => sum + blockTokens(b), 0);
    expect(contextTokens(onLarge)).toBeGreaterThan(2 * contextTokens(onSmall));
    expect(onLarge.context.length).toBeGreaterThan(onSmall.context.length);
    // The Brief, too, gets more of the larger window.
    expect(onLarge.foundation.brief?.markdown.length ?? 0).toBeGreaterThan(
      onSmall.foundation.brief?.markdown.length ?? 0,
    );
  });

  test('a few very long Thai messages compact before they overflow, and the summary keeps an agreed point and an id', async () => {
    const agreed = 'ตกลงว่าจะรอผู้ให้บริการไม่เกิน 24 ชั่วโมง ตามตั๋ว PAY-142';
    const first = `${thai(1_400)}\n${agreed}`;
    const started = await start(first, small);
    expect(started.status).toBe(201);
    const id = started.body.id;
    await expectFits(chatCalls().at(-1) as ChatInput, 8_000);

    for (let turn = 2; turn <= 5; turn++) {
      const res = await send(id, thai(1_500, `${turn} `));
      expect(res.status).toBe(201);
      // Every turn fits, however much was said before.
      await expectFits(chatCalls().at(-1) as ChatInput, 8_000);
    }

    // It compacted (before overflowing), and folded the first message into the summary.
    expect(summarizeCalls().length).toBeGreaterThan(0);
    expect(summarizeCalls()[0]?.messages[0]).toEqual({ role: 'USER', content: first });
    const last = chatCalls().at(-1) as ChatInput;
    expect(last.recentMessages.some((m) => m.content === first)).toBe(false);
    expect(last.summary).toContain(agreed);
    expect(last.summary).toContain('PAY-142');

    // Every message is still stored and shown; the view says where the summary ends.
    const view = await asPim()<ConversationView>('GET', `/conversations/${id}`);
    expect(view.body.messages).toHaveLength(10);
    expect(view.body.messages[0]?.content).toBe(first);
    expect(view.body.summarizedThrough).toBeGreaterThan(0);
    const row = await db.conversation.findUniqueOrThrow({ where: { id } });
    expect(view.body.summarizedThrough).toBe(row.summarizedThrough);
  });

  test('one long message alone is shortened for the AI only, and stays whole in the Conversation', async () => {
    const huge = thai(12_000);
    const started = await start(huge, small);
    expect(started.status).toBe(201);
    const sent = chatCalls().at(-1) as ChatInput;
    await expectFits(sent, 8_000);
    expect(sent.recentMessages[0]?.content.length).toBeLessThan(huge.length);
    expect(started.body.messages[0]?.content).toBe(huge);
  });

  test('a "too long" error from the provider compacts once and retries; the retry succeeds', async () => {
    const started = await start('Turn 1', large);
    const id = started.body.id;
    expect((await send(id, 'Turn 2')).status).toBe(201);
    expect(summarizeCalls()).toEqual([]);

    ai.scriptChat({ error: new ContextTooLongError(new Error('prompt is too long')) });
    const res = await send(id, 'Turn 3');
    expect(res.status).toBe(201);
    expect(res.body.reply.content).toContain('you said "Turn 3"');
    // One compaction, then the same step again with only the current turn.
    expect(summarizeCalls()).toHaveLength(1);
    expect(summarizeCalls()[0]?.messages).toHaveLength(4);
    const [failed, retried] = chatCalls().slice(-2);
    expect(failed?.recentMessages).toHaveLength(5);
    expect(retried?.recentMessages).toEqual([{ role: 'USER', content: 'Turn 3' }]);
    expect(retried?.summary).toContain('USER: Turn 1');
    expect(res.body.conversation.summarizedThrough).toBe(4);
    expect(await db.conversationMessage.count({ where: { conversationId: id } })).toBe(6);
  });

  test('a second "too long" is a 502, and no half reply is stored', async () => {
    const started = await start('Turn 1', large);
    const id = started.body.id;
    expect((await send(id, 'Turn 2')).status).toBe(201);
    events.length = 0;

    ai.scriptChat(
      { chunks: [{ type: 'text', delta: 'Half a ' }], error: new ContextTooLongError() },
      { error: new ContextTooLongError() },
    );
    const res = await asPim()<ConversationReplyFailed>('POST', `/conversations/${id}/messages`, {
      content: 'Turn 3',
    });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ statusCode: 502, conversationId: id });
    expect(summarizeCalls()).toHaveLength(1);
    const rows = await db.conversationMessage.findMany({
      where: { conversationId: id },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ['USER', 'Turn 1'],
      ['ASSISTANT', expect.any(String)],
      ['USER', 'Turn 2'],
      ['ASSISTANT', expect.any(String)],
      ['USER', 'Turn 3'],
    ]);
    expect(rows.some((m) => m.content.includes('Half a'))).toBe(false);
    expect(events.map((e) => e.event)).toContain('conversation.failed');

    // Retrying works once the provider accepts it again, from the compacted history.
    const retried = await asPim()<ConversationTurnView>('POST', `/conversations/${id}/retry`);
    expect(retried.status).toBe(201);
    expect(chatCalls().at(-1)?.recentMessages).toEqual([{ role: 'USER', content: 'Turn 3' }]);
  });

  test('an Admin sees and edits a model window; a known model is prefilled', async () => {
    const listed = await asPim()<{
      models: ApprovedModelSettingsView[];
      providers: AiProviderView[];
    }>('GET', '/settings/ai');
    const providerId = listed.body.providers[0]?.id;
    const known = await asPim()<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId,
      modelId: 'gpt-4o-mini',
      displayName: 'Mini',
    });
    expect(known.body.contextWindow).toBe(128_000);
    const unknown = await asPim()<ApprovedModelSettingsView>('POST', '/settings/ai/models', {
      providerId,
      modelId: 'qwen-3-coder',
      displayName: 'Qwen',
    });
    expect(unknown.body.contextWindow).toBe(32_000);

    const edited = await asPim()<ApprovedModelSettingsView>(
      'PATCH',
      `/settings/ai/models/${unknown.body.id}`,
      { contextWindow: 65_536 },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.contextWindow).toBe(65_536);
    // A new model id takes its own prefilled window unless one is given.
    const moved = await asPim()<ApprovedModelSettingsView>(
      'PATCH',
      `/settings/ai/models/${unknown.body.id}`,
      { modelId: 'claude-haiku-4-5' },
    );
    expect(moved.body.contextWindow).toBe(200_000);
    const tooSmall = await asPim()('PATCH', `/settings/ai/models/${unknown.body.id}`, {
      contextWindow: 1_000,
    });
    expect(tooSmall.status).toBe(400);
  });
});
