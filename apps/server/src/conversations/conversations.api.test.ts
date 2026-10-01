import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, SEED_SPEC_V1, seed } from '@vorasaan/db/seed';
import type {
  ConversationList,
  ConversationReplyFailed,
  ConversationTurnView,
  ConversationView,
  ServerEvent,
} from '@vorasaan/shared';
import type { ChatChunk, ChatMessageForAi, ContextBlock } from '../ai/ai.port.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { CONVERSATION_LIMITS } from './conversations.service.ts';

const { pim, beam } = SEED.users;
const SECRET = 'CARD-ISSUING-SECRET';

type ChatInput = {
  scope: { kind: string };
  context: ContextBlock[];
  foundation: { brief: { version: number; markdown: string } | null; guidelines: unknown[] };
  summary: string;
  recentMessages: ChatMessageForAi[];
  tools: unknown[];
};
type SummarizeInput = { summary: string; messages: ChatMessageForAi[] };

describe('Conversations', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let bus: EventBus;
  let events: { userId: string; event: ServerEvent }[];
  let unsubscribe: (() => void)[] = [];
  /** The other Project, whose material must never reach a Conversation in Mobile Banking. */
  let other: { projectId: string; featureId: string; specId: string; attachmentId: string };
  let decisionId: string;

  const asPim = () => as(app, pim.id);
  const asBeam = () => as(app, beam.id);
  const chatCalls = () =>
    ai.calls.filter((c) => c.method === 'chat').map((c) => c.input as ChatInput);
  const summarizeCalls = () =>
    ai.calls
      .filter((c) => c.method === 'summarizeConversation')
      .map((c) => c.input as SummarizeInput);
  const conversationEvents = (userId: string) =>
    events
      .filter((e) => e.userId === userId && e.event.event.startsWith('conversation.'))
      .map((e) => e.event);

  function startFeature(by: string, content: string) {
    return as(app, by)<ConversationView>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content,
    });
  }

  function send(by: string, id: string, content: string) {
    return as(app, by)<ConversationTurnView>('POST', `/conversations/${id}/messages`, { content });
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

    const decided = await db.decisionRequest.create({
      data: {
        featureId: SEED.featureId,
        kind: 'BLOCKER',
        raiserId: beam.id,
        title: 'Provider has no webhook',
        description: 'Only polling is available for checkout payments.',
        deciderRole: 'PO',
        status: 'DECIDED',
      },
    });
    const decision = await db.decision.create({
      data: {
        requestId: decided.id,
        decidedById: pim.id,
        customAnswer: 'Poll every 5 seconds for up to 24 hours.',
      },
    });
    decisionId = decision.id;

    // Another Project whose Spec and Attachment talk about checkout payments too.
    const project = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Card Issuing' },
    });
    const team = await db.team.create({ data: { projectId: project.id, name: 'Cards' } });
    const feature = await db.feature.create({ data: { teamId: team.id, title: 'Card checkout' } });
    const spec = await db.specVersion.create({
      data: {
        featureId: feature.id,
        version: 1,
        markdown: `# Card checkout\n\nCheckout payments poll the provider. ${SECRET}\n`,
        source: 'MANUAL',
        approvedById: pim.id,
      },
    });
    const attachment = await db.attachment.create({
      data: {
        featureId: feature.id,
        source: 'FILE',
        title: 'Card checkout notes',
        snapshotText: `Checkout payment provider webhook notes. ${SECRET}`,
        snapshotAt: new Date(),
        addedById: pim.id,
      },
    });
    const indexing = app.get(IndexingService);
    await indexing.index({ source: 'SPEC_VERSION', id: spec.id });
    await indexing.index({ source: 'ATTACHMENT', id: attachment.id });
    other = {
      projectId: project.id,
      featureId: feature.id,
      specId: spec.id,
      attachmentId: attachment.id,
    };

    events = [];
    unsubscribe = [pim.id, beam.id].map((userId) =>
      bus.subscribe(userId, (event) => events.push({ userId, event })),
    );
  });

  afterEach(() => {
    for (const off of unsubscribe) off();
  });

  test("a Feature Conversation: the AI reads that Feature's Spec and Decisions, nothing from another Project; the reply is stored and streamed", async () => {
    const res = await startFeature(pim.id, 'How do we handle the provider checkout payments?');
    expect(res.status).toBe(201);
    const conversation = res.body;
    expect(conversation).toMatchObject({
      title: 'How do we handle the provider checkout payments?',
      scope: {
        kind: 'FEATURE',
        project: { id: SEED.projectId, name: 'Mobile Banking' },
        feature: { id: SEED.featureId, title: 'Async checkout' },
      },
    });
    expect(conversation.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
    const [question, reply] = conversation.messages;
    expect(question?.content).toBe('How do we handle the provider checkout payments?');
    expect(reply?.content).toBe(
      `About the Feature "Async checkout": you said "How do we handle the provider checkout payments?". I read ${chatCalls()[0]?.context.length} context blocks.`,
    );
    expect(reply?.toolCalls).toBeNull();

    // The AI input: the Feature's own Spec and Decision, and only the newest message.
    const [input] = chatCalls();
    if (!input) throw new Error('expected a chat call');
    expect(input.scope.kind).toBe('FEATURE');
    // Tools only draft or read (Action Cards, 0043); action-cards.api.test.ts covers them.
    expect((input.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
      'draftDecisionRequest',
      'draftSpecProposal',
      'searchContext',
    ]);
    expect(input.summary).toBe('');
    expect(input.recentMessages).toEqual([
      { role: 'USER', content: 'How do we handle the provider checkout payments?' },
    ]);
    const [spec] = input.context;
    expect(spec).toMatchObject({ source: { kind: 'SPEC_VERSION' }, scope: 'FEATURE' });
    expect(spec?.text).toBe(SEED_SPEC_V1);
    const decision = input.context.find((b) => b.source.id === decisionId);
    expect(decision).toMatchObject({ source: { kind: 'DECISION' }, scope: 'FEATURE' });
    expect(decision?.text).toContain('Poll every 5 seconds');
    const otherIds = new Set(Object.values(other));
    for (const block of input.context) {
      expect(block.text).not.toContain(SECRET);
      expect(otherIds.has(block.source.id)).toBe(false);
    }

    // Streamed to the owner only, in pieces that add up to the stored reply.
    const streamed = conversationEvents(pim.id);
    const deltas = streamed.flatMap((e) => (e.event === 'conversation.delta' ? [e.data] : []));
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.every((d) => d.conversationId === conversation.id)).toBe(true);
    expect(deltas.every((d) => d.messageId === reply?.id)).toBe(true);
    expect(deltas.map((d) => d.delta).join('')).toBe(reply?.content ?? '');
    expect(streamed.at(-1)).toEqual({
      event: 'conversation.done',
      data: { conversationId: conversation.id, message: reply as never },
    });
    expect(conversationEvents(beam.id)).toEqual([]);

    // Stored: reading it back gives the same messages.
    const read = await asPim()<ConversationView>('GET', `/conversations/${conversation.id}`);
    expect(read.status).toBe(200);
    expect(read.body.messages).toEqual(conversation.messages);
  });

  test('a Project Conversation reads the Project Brief and the Project, and the next message continues it', async () => {
    await db.briefVersion.create({
      data: {
        projectId: SEED.projectId,
        version: 1,
        markdown: '# Project Brief\n\n## Business goals\nGrow mobile payments.\n',
        source: 'MANUAL',
        approvedById: pim.id,
      },
    });
    const res = await asBeam()<ConversationView>('POST', '/conversations', {
      scope: { kind: 'PROJECT', projectId: SEED.projectId },
      content: '  What are our business goals?\nAnd what is in flight?  ',
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('What are our business goals?');
    expect(res.body.scope).toEqual({
      kind: 'PROJECT',
      project: { id: SEED.projectId, name: 'Mobile Banking' },
    });
    const [input] = chatCalls();
    expect(input?.scope.kind).toBe('PROJECT');
    expect(input?.foundation.brief).toEqual({
      version: 1,
      markdown: '# Project Brief\n\n## Business goals\nGrow mobile payments.\n',
    });
    expect(input?.context.some((b) => b.source.kind === 'BRIEF_VERSION')).toBe(false);
    expect(input?.context.some((b) => b.source.title === 'Spec: Async checkout')).toBe(true);
    for (const block of input?.context ?? []) expect(block.text).not.toContain(SECRET);

    const next = await send(beam.id, res.body.id, 'Thanks. Which Feature is riskiest?');
    expect(next.status).toBe(201);
    expect(next.body.message).toMatchObject({ role: 'USER' });
    expect(next.body.reply.content).toContain('you said "Thanks. Which Feature is riskiest?"');
    expect(chatCalls()[1]?.recentMessages.map((m) => m.role)).toEqual([
      'USER',
      'ASSISTANT',
      'USER',
    ]);

    const list = await asBeam()<ConversationList>('GET', '/conversations?recent');
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((c) => c.id)).toEqual([res.body.id]);
    expect(
      (await asBeam()<ConversationList>('GET', `/conversations?featureId=${SEED.featureId}`)).body
        .conversations,
    ).toEqual([]);
    expect(
      (await asBeam()<ConversationList>('GET', `/conversations?projectId=${SEED.projectId}`)).body
        .conversations,
    ).toHaveLength(1);
  });

  test("another user, an Admin included, gets 404 on someone else's Conversation", async () => {
    const mine = await startFeature(beam.id, 'Private thoughts about checkout');
    expect(mine.status).toBe(201);
    const id = mine.body.id;
    events.length = 0;

    // Pim is an Admin of the Organization: still not his to read.
    expect((await asPim()('GET', `/conversations/${id}`)).status).toBe(404);
    expect((await send(pim.id, id, 'Peek')).status).toBe(404);
    expect((await asPim()('POST', `/conversations/${id}/retry`)).status).toBe(404);
    expect((await asPim()('DELETE', `/conversations/${id}`)).status).toBe(404);
    const list = await asPim()<ConversationList>('GET', '/conversations');
    expect(list.body.conversations).toEqual([]);
    expect(conversationEvents(pim.id)).toEqual([]);
    expect(await db.conversationMessage.count({ where: { conversationId: id } })).toBe(2);

    // Beam still reads it, and deletes it.
    expect((await asBeam()('GET', `/conversations/${id}`)).status).toBe(200);
    expect((await asBeam()('DELETE', `/conversations/${id}`)).status).toBe(204);
    expect((await asBeam()('GET', `/conversations/${id}`)).status).toBe(404);
    expect(await db.conversationMessage.count()).toBe(0);
  });

  test('someone removed from the Organization can no longer get replies in their old Conversation', async () => {
    const mine = await startFeature(beam.id, 'What does the Spec say about retries?');
    expect(mine.status).toBe(201);
    const id = mine.body.id;
    await db.orgMembership.delete({
      where: { organizationId_userId: { organizationId: SEED.organizationId, userId: beam.id } },
    });
    const before = chatCalls().length;

    expect((await send(beam.id, id, 'And the timeout?')).status).toBe(403);
    expect((await asBeam()('POST', `/conversations/${id}/retry`)).status).toBe(403);
    expect(chatCalls().length).toBe(before);
    expect(await db.conversationMessage.count({ where: { conversationId: id } })).toBe(2);
  });

  test('past N turns the summary is updated, and older turns are not sent again', async () => {
    const { maxRecentMessages, keepRecentMessages } = CONVERSATION_LIMITS;
    const started = await startFeature(pim.id, 'Turn 1');
    const id = started.body.id;
    // Each turn adds two messages; the first fold comes once the unsummarized ones pass the limit.
    const turnsBeforeFold = Math.floor(maxRecentMessages / 2);
    for (let turn = 2; turn <= turnsBeforeFold; turn++) {
      expect((await send(pim.id, id, `Turn ${turn}`)).status).toBe(201);
    }
    expect(summarizeCalls()).toEqual([]);
    expect(chatCalls().at(-1)?.recentMessages).toHaveLength(maxRecentMessages - 1);

    const foldTurn = turnsBeforeFold + 1;
    expect((await send(pim.id, id, `Turn ${foldTurn}`)).status).toBe(201);
    const [fold] = summarizeCalls();
    const folded = maxRecentMessages + 1 - keepRecentMessages;
    expect(fold?.summary).toBe('');
    expect(fold?.messages).toHaveLength(folded);
    expect(fold?.messages[0]).toEqual({ role: 'USER', content: 'Turn 1' });

    const after = chatCalls().at(-1);
    expect(after?.summary).toContain('USER: Turn 1');
    expect(after?.recentMessages).toHaveLength(keepRecentMessages);
    expect(after?.recentMessages.at(-1)).toEqual({ role: 'USER', content: `Turn ${foldTurn}` });
    const sent = (after?.recentMessages ?? []).map((m) => m.content).join('\n');
    expect(sent).not.toContain('Turn 1\n');
    expect(after?.recentMessages.some((m) => m.content === 'Turn 1')).toBe(false);
    const row = await db.conversation.findUniqueOrThrow({ where: { id } });
    expect(row.summarizedThrough).toBe(folded);
    expect(row.summary).toBe(after?.summary ?? '');

    // The next turn keeps the summary and sends only what came after it.
    expect((await send(pim.id, id, `Turn ${foldTurn + 1}`)).status).toBe(201);
    expect(summarizeCalls()).toHaveLength(1);
    const next = chatCalls().at(-1);
    expect(next?.summary).toBe(row.summary);
    expect(next?.recentMessages).toHaveLength(keepRecentMessages + 2);
    // Every message is still stored and shown to the owner.
    const all = await asPim()<ConversationView>('GET', `/conversations/${id}`);
    expect(all.body.messages).toHaveLength((foldTurn + 1) * 2);
  });

  test("an AI failure stores no half reply and returns 502; the person's message stays, so they can retry", async () => {
    const started = await startFeature(pim.id, 'First question');
    const id = started.body.id;
    events.length = 0;

    ai.scriptChat({
      chunks: [{ type: 'text', delta: 'Half a ' }],
      error: new Error('provider unreachable'),
    });
    const failed = await as(app, pim.id)<ConversationReplyFailed>(
      'POST',
      `/conversations/${id}/messages`,
      { content: 'Second question' },
    );
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ statusCode: 502, conversationId: id });
    const rows = await db.conversationMessage.findMany({
      where: { conversationId: id },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ['USER', 'First question'],
      ['ASSISTANT', expect.any(String)],
      ['USER', 'Second question'],
    ]);
    const streamed = conversationEvents(pim.id);
    expect(streamed.map((e) => e.event)).toEqual(['conversation.delta', 'conversation.failed']);
    const [delta, failure] = streamed;
    if (delta?.event !== 'conversation.delta' || failure?.event !== 'conversation.failed') {
      throw new Error('expected a delta, then a failure');
    }
    expect(failure.data).toMatchObject({ conversationId: id, messageId: delta.data.messageId });

    // Retrying answers the same message: no duplicate, and the reply is stored.
    const retried = await asPim()<ConversationTurnView>('POST', `/conversations/${id}/retry`);
    expect(retried.status).toBe(201);
    expect(retried.body.message).toMatchObject({ id: rows[2]?.id, content: 'Second question' });
    expect(retried.body.reply.content).toContain('you said "Second question"');
    expect(await db.conversationMessage.count({ where: { conversationId: id } })).toBe(4);
    // Nothing left to retry once the last message has its reply.
    expect((await asPim()('POST', `/conversations/${id}/retry`)).status).toBe(409);
  });

  test('a failed first reply still creates the Conversation with its message, and says where', async () => {
    ai.scriptChat({ error: new Error('provider unreachable') });
    const failed = await as(app, pim.id)<ConversationReplyFailed>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content: 'Hello?',
    });
    expect(failed.status).toBe(502);
    const conversation = await asPim()<ConversationView>(
      'GET',
      `/conversations/${failed.body.conversationId}`,
    );
    expect(conversation.status).toBe(200);
    expect(conversation.body.messages.map((m) => [m.role, m.content])).toEqual([
      ['USER', 'Hello?'],
    ]);
  });

  test('a failed summary is a 502 too, and the message stays', async () => {
    const started = await startFeature(pim.id, 'Turn 1');
    const id = started.body.id;
    for (let turn = 2; turn <= CONVERSATION_LIMITS.maxRecentMessages / 2; turn++) {
      await send(pim.id, id, `Turn ${turn}`);
    }
    const original = ai.summarizeConversation;
    ai.summarizeConversation = async () => {
      throw new Error('provider unreachable');
    };
    try {
      expect((await send(pim.id, id, 'One more')).status).toBe(502);
    } finally {
      ai.summarizeConversation = original;
    }
    const row = await db.conversation.findUniqueOrThrow({
      where: { id },
      include: { messages: { orderBy: { position: 'desc' }, take: 1 } },
    });
    expect(row.summarizedThrough).toBe(0);
    expect(row.messages[0]).toMatchObject({ role: 'USER', content: 'One more' });
    expect((await asPim()('POST', `/conversations/${id}/retry`)).status).toBe(201);
  });

  test('a second message while a reply is being written is refused', async () => {
    const started = await startFeature(pim.id, 'First');
    const id = started.body.id;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ai.chat.bind(ai);
    ai.chat = async function* (input) {
      await gate;
      yield* original(input) as AsyncIterable<ChatChunk>;
    };
    try {
      const slow = send(pim.id, id, 'Slow one');
      // Let the first request reach the AI before sending the second.
      for (let i = 0; i < 50 && chatCalls().length < 1; i++) await Bun.sleep(5);
      await Bun.sleep(20);
      const second = await send(pim.id, id, 'Impatient');
      expect(second.status).toBe(409);
      release();
      expect((await slow).status).toBe(201);
    } finally {
      ai.chat = original;
    }
    const rows = await db.conversationMessage.findMany({
      where: { conversationId: id },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((m) => m.content).slice(2, 3)).toEqual(['Slow one']);
    expect(rows).toHaveLength(4);
  });

  test('a scripted tool call the turn did not offer is not stored', async () => {
    ai.scriptChat({
      chunks: [
        { type: 'text', delta: 'Let me draft that.' },
        { type: 'tool-call', call: { id: 'c1', name: 'approveSpec', args: {} } },
      ],
    });
    const res = await startFeature(pim.id, 'Approve the Spec for me');
    expect(res.status).toBe(201);
    expect(res.body.messages[1]).toMatchObject({
      content: 'Let me draft that.',
      toolCalls: null,
    });
  });

  test('scope and input are checked', async () => {
    const unknown = '00000000-0000-4000-8000-00000000dead';
    expect(
      (
        await asPim()('POST', '/conversations', {
          scope: { kind: 'FEATURE', featureId: unknown },
          content: 'Hi',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await asPim()('POST', '/conversations', {
          scope: { kind: 'PROJECT', projectId: unknown },
          content: 'Hi',
        })
      ).status,
    ).toBe(404);
    expect((await startFeature(pim.id, '   ')).status).toBe(400);
    expect((await asPim()('GET', `/conversations/${unknown}`)).status).toBe(404);
    expect((await asPim()('GET', '/conversations/not-a-uuid')).status).toBe(400);
    expect(ai.calls).toEqual([]);
    expect(await db.conversation.count()).toBe(0);
  });
});
