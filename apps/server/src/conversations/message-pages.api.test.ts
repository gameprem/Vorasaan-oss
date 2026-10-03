import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  ConversationMessagePage,
  ConversationMessageView,
  ConversationTurnView,
  ConversationView,
} from '@vorasaan/shared';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

// Chat history in pages, like a chat app (ticket 0066): a Conversation opens on its
// latest messages, and older (or, from a deep link, newer) pages load from a cursor
// that names one message, so nothing is skipped or repeated whatever arrives meanwhile.

const { pim, beam } = SEED.users;

describe('Pages of a Conversation’s messages (0066)', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  const asPim = () => as(app, pim.id);

  /** A Feature Conversation of `count` stored messages, USER and ASSISTANT in turn. */
  async function conversationOf(count: number, createdAt?: (i: number) => Date): Promise<string> {
    const conversation = await db.conversation.create({
      data: {
        ownerId: pim.id,
        projectId: SEED.projectId,
        featureId: SEED.featureId,
        title: 'A long chat',
      },
    });
    const start = Date.now() - count * 1_000;
    await db.conversationMessage.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        conversationId: conversation.id,
        position: i,
        role: i % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
        content: `Message ${i}`,
        createdAt: createdAt?.(i) ?? new Date(start + i * 1_000),
      })),
    });
    return conversation.id;
  }

  const positions = (messages: ConversationMessageView[]) => messages.map((m) => m.position);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  function page(id: string, query = '') {
    return asPim()<ConversationMessagePage>('GET', `/conversations/${id}/messages${query}`);
  }

  /** Every page from the latest back to the first, following `olderCursor`. */
  async function pageBack(id: string, limit: number) {
    const pages: ConversationMessagePage[] = [];
    let res = await page(id, `?limit=${limit}`);
    for (;;) {
      expect(res.status).toBe(200);
      pages.push(res.body);
      if (!res.body.olderCursor) return pages;
      res = await page(id, `?before=${res.body.olderCursor}&limit=${limit}`);
    }
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
  });

  test('opening a Conversation gives its latest 50 messages, oldest first, with a cursor back', async () => {
    const id = await conversationOf(120);
    const res = await asPim()<ConversationView>('GET', `/conversations/${id}`);
    expect(res.status).toBe(200);
    expect(positions(res.body.messages)).toEqual(range(70, 119));
    expect(res.body.page.olderCursor).toBeString();
    expect(res.body.page.newerCursor).toBeNull();

    // The same page from the messages route.
    const latest = await page(id);
    expect(latest.status).toBe(200);
    expect(positions(latest.body.messages)).toEqual(range(70, 119));
    expect(latest.body.olderCursor).toBe(res.body.page.olderCursor);
  });

  test('pages come newest first; the first and last pages have the right edges, with no duplicates', async () => {
    const id = await conversationOf(120);
    const pages = await pageBack(id, 50);
    expect(pages.map((p) => positions(p.messages))).toEqual([
      range(70, 119),
      range(20, 69),
      range(0, 19),
    ]);
    // The latest page has nothing newer; the first has nothing older, and no cursor past it.
    expect(pages[0]?.newerCursor).toBeNull();
    expect(pages[2]?.olderCursor).toBeNull();
    // Paging back, each page knows there is something newer again.
    expect(pages[1]?.newerCursor).toBeString();
    expect(pages[2]?.newerCursor).toBeString();
    const all = pages.flatMap((p) => positions(p.messages));
    expect(new Set(all).size).toBe(120);

    // An exact multiple of the page size: the last page is full, and still has no cursor back.
    const even = await conversationOf(100);
    const evenPages = await pageBack(even, 50);
    expect(evenPages.map((p) => p.messages.length)).toEqual([50, 50]);
    expect(evenPages[1]?.olderCursor).toBeNull();

    // A short Conversation is one page with no cursors.
    const short = await conversationOf(3);
    const one = await page(short);
    expect(positions(one.body.messages)).toEqual([0, 1, 2]);
    expect(one.body.olderCursor).toBeNull();
    expect(one.body.newerCursor).toBeNull();
  });

  test('messages written in the same millisecond are neither skipped nor repeated', async () => {
    const sameTime = new Date('2026-10-01T09:00:00.000Z');
    const id = await conversationOf(57, () => sameTime);
    const pages = await pageBack(id, 10);
    const all = pages.flatMap((p) => positions(p.messages));
    expect(all.toSorted((a, b) => a - b)).toEqual(range(0, 56));
    expect(new Set(all).size).toBe(57);
    // Within each page, oldest first, in the order they were written.
    for (const p of pages) {
      expect(positions(p.messages)).toEqual(positions(p.messages).toSorted((a, b) => a - b));
    }
  });

  test('messages that arrive while a person pages back do not shift or repeat the older pages', async () => {
    const id = await conversationOf(120);
    const latest = await page(id);
    // A new turn arrives (the person's message and the AI's reply) before the next page loads.
    const sent = await asPim()<ConversationTurnView>('POST', `/conversations/${id}/messages`, {
      content: 'One more thing',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.reply.position).toBe(121);

    const older = await page(id, `?before=${latest.body.olderCursor}`);
    expect(positions(older.body.messages)).toEqual(range(20, 69));
    // The latest page now ends with them.
    const now = await page(id);
    expect(positions(now.body.messages)).toEqual(range(72, 121));
    expect(now.body.newerCursor).toBeNull();
  });

  test('a deep link loads the page around a message, and pages load both ways from it', async () => {
    const id = await conversationOf(120);
    const target = await db.conversationMessage.findFirstOrThrow({
      where: { conversationId: id, position: 40 },
    });
    const around = await page(id, `?around=${target.id}&limit=20`);
    expect(around.status).toBe(200);
    expect(positions(around.body.messages)).toEqual(range(30, 49));
    expect(around.body.olderCursor).toBeString();
    expect(around.body.newerCursor).toBeString();

    // The Conversation itself opens there too.
    const view = await asPim()<ConversationView>(
      'GET',
      `/conversations/${id}?around=${target.id}&limit=20`,
    );
    expect(positions(view.body.messages)).toEqual(range(30, 49));
    expect(view.body.page.newerCursor).toBe(around.body.newerCursor);

    // Newer pages up to the latest, older pages back to the first: every message once.
    const seen = [...positions(around.body.messages)];
    let cursor: string | null = around.body.newerCursor;
    while (cursor) {
      const next = await page(id, `?after=${cursor}&limit=20`);
      seen.push(...positions(next.body.messages));
      cursor = next.body.newerCursor;
    }
    cursor = around.body.olderCursor;
    while (cursor) {
      const next = await page(id, `?before=${cursor}&limit=20`);
      seen.unshift(...positions(next.body.messages));
      cursor = next.body.olderCursor;
    }
    expect(seen).toEqual(range(0, 119));

    // Near either end, the page is cut there and has no cursor that way.
    const first = await db.conversationMessage.findFirstOrThrow({
      where: { conversationId: id, position: 2 },
    });
    const atStart = await page(id, `?around=${first.id}&limit=20`);
    expect(positions(atStart.body.messages)).toEqual(range(0, 19));
    expect(atStart.body.olderCursor).toBeNull();
  });

  test('someone who cannot read the Conversation gets a 404 on its messages', async () => {
    const id = await conversationOf(10);
    const asBeam = as(app, beam.id);
    expect((await asBeam('GET', `/conversations/${id}/messages`)).status).toBe(404);
    expect((await asBeam('GET', `/conversations/${id}`)).status).toBe(404);
    // A cursor or a message of another Conversation finds nothing here either.
    const other = await conversationOf(10);
    const elsewhere = await db.conversationMessage.findFirstOrThrow({
      where: { conversationId: other, position: 3 },
    });
    expect((await page(id, `?around=${elsewhere.id}`)).status).toBe(404);
    const otherPage = await page(other, '?limit=5');
    const foreign = await page(id, `?before=${otherPage.body.olderCursor}`);
    expect(foreign.status).toBe(400);
  });

  test('a cursor that is not one, or two directions at once, is a 400', async () => {
    const id = await conversationOf(10);
    expect((await page(id, '?before=not%20a%20cursor')).status).toBe(400);
    expect((await page(id, '?before=AAAA')).status).toBe(400);
    const latest = await page(id, '?limit=5');
    const both = await page(
      id,
      `?before=${latest.body.olderCursor}&after=${latest.body.olderCursor}`,
    );
    expect(both.status).toBe(400);
    expect((await page(id, '?limit=500')).status).toBe(400);
  });
});
