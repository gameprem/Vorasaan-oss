import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, SEED_SPEC_V1, seed } from '@vorasaan/db/seed';
import type {
  ActionCardView,
  ConversationTurnView,
  ConversationView,
  ServerEvent,
  StopConversationResult,
  TeamView,
} from '@vorasaan/shared';
import type { ChatChunk } from '../ai/ai.port.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

// What the web's chat view (ticket 0046) needs from the API: a stop button, Action
// Cards that carry what they propose (and who approves it), and a dev-only way for
// the end-to-end tests to script the fake AI.

const { pim, beam } = SEED.users;
const NEW_SPEC = `${SEED_SPEC_V1.trimEnd()}\n\n## Timeouts\n- Treat a payment as failed after 24 hours.\n`;
const feature = { kind: 'FEATURE', featureId: SEED.featureId };

const text = (delta: string): ChatChunk => ({ type: 'text', delta });
const call = (id: string, name: string, args: unknown): ChatChunk => ({
  type: 'tool-call',
  call: { id, name, args },
});

describe('the chat view API (0046)', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let bus: EventBus;
  let events: { userId: string; event: ServerEvent }[];
  let unsubscribe: (() => void)[] = [];

  const start = (by: string, content: string) =>
    as(app, by)<ConversationView>('POST', '/conversations', { scope: feature, content });
  const send = (by: string, id: string, content: string) =>
    as(app, by)<ConversationTurnView>('POST', `/conversations/${id}/messages`, { content });
  const stop = (by: string, id: string) =>
    as(app, by)<StopConversationResult>('POST', `/conversations/${id}/stop`);

  /** Resolves on the first `conversation.delta` sent to `userId` from now on. */
  function nextDelta(userId: string) {
    return new Promise<void>((resolve) => {
      const off = bus.subscribe(userId, (event) => {
        if (event.event === 'conversation.delta') {
          off();
          resolve();
        }
      });
    });
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
    unsubscribe = [pim.id, beam.id].map((userId) =>
      bus.subscribe(userId, (event) => events.push({ userId, event })),
    );
  });

  afterEach(() => {
    for (const off of unsubscribe) off();
  });

  describe('stopping a reply', () => {
    test('keeps what was written so far as the reply, and the turn answers as usual', async () => {
      const conversation = (await start(pim.id, 'Hello')).body;
      ai.scriptChat({
        chunks: ['One ', 'two ', 'three ', 'four ', 'five ', 'six'].map(text),
        chunkDelayMs: 40,
      });
      const streaming = nextDelta(pim.id);
      const turn = send(pim.id, conversation.id, 'Count to six, slowly');
      await streaming;

      const stopped = await stop(pim.id, conversation.id);
      expect(stopped.status).toBe(202);
      expect(stopped.body).toEqual({ stopped: true });

      const res = await turn;
      expect(res.status).toBe(201);
      const written = res.body.reply.content;
      expect(written.startsWith('One ')).toBe(true);
      expect(written.length).toBeLessThan('One two three four five six'.length);

      // Stored like any reply, and announced as done.
      const view = (
        await as(app, pim.id)<ConversationView>('GET', `/conversations/${conversation.id}`)
      ).body;
      expect(view.messages.at(-1)).toMatchObject({ role: 'ASSISTANT', content: written });
      const done = events.filter(
        (e) =>
          e.event.event === 'conversation.done' && e.event.data.conversationId === conversation.id,
      );
      expect(done).toHaveLength(2);
      expect(events.some((e) => e.event.event === 'conversation.failed')).toBe(false);

      // Nothing is being written any more, and the last message has its reply.
      expect((await stop(pim.id, conversation.id)).status).toBe(409);
      expect(
        (await as(app, pim.id)('POST', `/conversations/${conversation.id}/retry`)).status,
      ).toBe(409);
    });

    test('drops the tool calls of the step it stopped, so nothing is drafted', async () => {
      const conversation = (await start(pim.id, 'Hello')).body;
      ai.scriptChat({
        chunks: [
          text('Drafting '),
          text('the change '),
          text('now. '),
          call('call-1', 'draftSpecProposal', { proposedMarkdown: NEW_SPEC, summary: 'Timeouts' }),
        ],
        chunkDelayMs: 40,
      });
      const streaming = nextDelta(pim.id);
      const turn = send(pim.id, conversation.id, 'Add a timeout to the Spec');
      await streaming;
      expect((await stop(pim.id, conversation.id)).status).toBe(202);

      const res = await turn;
      expect(res.status).toBe(201);
      expect(res.body.steps).toEqual([]);
      expect(res.body.actionCards).toEqual([]);
      expect(await db.specProposal.count()).toBe(0);
      expect(await db.conversationMessage.count({ where: { role: 'TOOL' } })).toBe(0);
    });

    test('is the owner’s alone, and a 409 when no reply is being written', async () => {
      const conversation = (await start(pim.id, 'Hello')).body;
      expect((await stop(pim.id, conversation.id)).status).toBe(409);

      ai.scriptChat({ chunks: ['a ', 'b ', 'c ', 'd'].map(text), chunkDelayMs: 40 });
      const streaming = nextDelta(pim.id);
      const turn = send(pim.id, conversation.id, 'Go on');
      await streaming;
      // Someone else, an Admin or not, never learns the Conversation exists.
      expect((await stop(beam.id, conversation.id)).status).toBe(404);
      expect((await turn).body.reply.content).toBe('a b c d');
    });
  });

  describe('Action Cards carry what they propose', () => {
    test('a Spec Proposal card: both sides, its approver, then the version it wrote', async () => {
      ai.scriptChat(
        {
          chunks: [
            call('call-1', 'draftSpecProposal', {
              proposedMarkdown: NEW_SPEC,
              summary: 'Adds a 24-hour timeout.',
            }),
          ],
        },
        { chunks: [text('Ready for you to approve.')] },
      );
      const conversation = (await start(pim.id, 'Add a timeout')).body;
      const card = conversation.actionCards[0] as ActionCardView;
      expect(card.detail).toEqual({
        kind: 'SPEC_PROPOSAL',
        featureId: SEED.featureId,
        approver: { id: pim.id, name: pim.name },
        baseVersion: 1,
        baseMarkdown: SEED_SPEC_V1,
        proposedMarkdown: NEW_SPEC,
        version: null,
      });
      // The SSE event carries the same.
      const created = events.find((e) => e.event.event === 'conversation.actionCard.created');
      expect(created?.event.data).toMatchObject({ card: { id: card.id, detail: card.detail } });

      const approved = await as(app, pim.id)<ActionCardView>(
        'POST',
        `/action-cards/${card.id}/approve`,
      );
      expect(approved.body).toMatchObject({ status: 'APPROVED', detail: { version: 2 } });
    });

    test('a Decision Request card: the draft, its Choices and who it goes to', async () => {
      ai.scriptChat(
        {
          chunks: [
            call('call-1', 'draftDecisionRequest', {
              kind: 'BLOCKER',
              title: 'Keep the cart after a failed payment?',
              description: 'The cart is lost when the provider times out.',
            }),
          ],
        },
        { chunks: [text('Drafted; review it before sending.')] },
      );
      const conversation = (await start(beam.id, 'Raise a Blocker about the cart')).body;
      const detail = conversation.actionCards[0]?.detail;
      expect(detail).toMatchObject({
        kind: 'DECISION_REQUEST',
        requestKind: 'BLOCKER',
        description: 'The cart is lost when the provider times out.',
        deciderRole: 'PO',
        recipients: [{ id: pim.id, name: pim.name }],
      });
      expect(detail?.kind === 'DECISION_REQUEST' && detail.choices.length).toBeGreaterThanOrEqual(
        2,
      );
    });

    test('a card whose target is gone has no detail', async () => {
      ai.scriptChat(
        {
          chunks: [
            call('call-1', 'draftSpecProposal', {
              proposedMarkdown: NEW_SPEC,
              summary: 'Timeouts',
            }),
          ],
        },
        { chunks: [text('Done.')] },
      );
      const conversation = (await start(pim.id, 'Add a timeout')).body;
      await db.specProposal.deleteMany();
      const view = (
        await as(app, pim.id)<ConversationView>('GET', `/conversations/${conversation.id}`)
      ).body;
      expect(view.actionCards[0]).toMatchObject({ status: 'STALE', detail: null });
    });
  });

  test('a Team’s Features say which Spec Version they are on', async () => {
    const team = (await as(app, pim.id)<TeamView>('GET', `/teams/${SEED.teamId}`)).body;
    expect(team.features.find((f) => f.id === SEED.featureId)?.specVersion).toBe(1);
  });

  describe('DEV: scripting the fake AI', () => {
    const script = (body: unknown) => as(app, pim.id)('POST', '/dev/fake-ai/chat-script', body);

    test('queues the next chat replies, tool calls included', async () => {
      const res = await script({
        replies: [
          {
            chunks: [
              { type: 'text', delta: 'Drafting it. ' },
              {
                type: 'tool-call',
                call: {
                  id: 'e2e-1',
                  name: 'draftSpecProposal',
                  args: { proposedMarkdown: NEW_SPEC, summary: 'Timeouts' },
                },
              },
            ],
          },
          { chunks: [{ type: 'text', delta: 'Approve it when ready.' }] },
        ],
      });
      expect(res.status).toBe(204);
      const conversation = (await start(pim.id, 'Add a timeout')).body;
      expect(conversation.actionCards).toHaveLength(1);
      expect(conversation.messages.at(-1)?.content).toBe('Approve it when ready.');
    });

    test('rejects an invalid script, and is gone without dev sign-in', async () => {
      expect((await script({ replies: [{ chunks: [{ type: 'image' }] }] })).status).toBe(400);
      const before = process.env.VORASAAN_DEV_AUTH;
      process.env.VORASAAN_DEV_AUTH = 'false';
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/dev/fake-ai/chat-script',
          payload: { replies: [{ chunks: [] }] },
        });
        // Without dev sign-in there is no dev identity either: the guard turns it away first.
        expect([401, 404]).toContain(res.statusCode);
      } finally {
        process.env.VORASAAN_DEV_AUTH = before;
      }
      expect(ai.chatScript).toHaveLength(0);
    });
  });
});
