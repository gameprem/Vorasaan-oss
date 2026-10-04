import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import {
  type ConversationTurnView,
  type ConversationView,
  type GrillingView,
  grillingNotesText,
  type InboxItem,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import type { FakeAiPort } from './fake-ai.port.ts';
import { personLanguage, projectLanguage } from './language.ts';

const { pim, beam } = SEED.users;

// Ticket 0068: the AI replies in the person's language, else the Organization's, else
// English, and the server's own Grilling texts follow the same language.
describe('the reply language (0068)', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;

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
    ai.followUpScript.length = 0;
  });

  const organizationSpeaks = (language: 'en' | 'th') =>
    db.organization.update({ where: { id: SEED.organizationId }, data: { language } });
  const personPicks = (userId: string, language: 'en' | 'th' | null) =>
    db.chatPreference.upsert({
      where: { userId },
      create: { userId, events: [], language },
      update: { language },
    });
  const callsOf = (method: string) => ai.calls.filter((c) => c.method === method);

  describe('resolving it', () => {
    test('English when nobody picked a language', async () => {
      expect(await personLanguage(db, pim.id)).toBe('en');
      expect(await projectLanguage(db, SEED.projectId)).toBe('en');
    });

    test("the Organization's when the person has none of their own", async () => {
      await organizationSpeaks('th');
      await personPicks(pim.id, null);
      expect(await personLanguage(db, pim.id)).toBe('th');
      expect(await projectLanguage(db, SEED.projectId)).toBe('th');
    });

    test("the person's own wins over the Organization's, either way", async () => {
      await organizationSpeaks('th');
      await personPicks(pim.id, 'en');
      expect(await personLanguage(db, pim.id)).toBe('en');
      await organizationSpeaks('en');
      await personPicks(beam.id, 'th');
      expect(await personLanguage(db, beam.id)).toBe('th');
    });

    test('English for someone unknown', async () => {
      expect(await personLanguage(db, '00000000-0000-4000-8000-00000000ffff')).toBe('en');
    });
  });

  describe('passing it to the AI', () => {
    test("a Conversation's reply is asked for in its owner's language", async () => {
      await personPicks(pim.id, 'th');
      const res = await as(app, pim.id)<ConversationView>('POST', '/conversations', {
        scope: { kind: 'FEATURE', featureId: SEED.featureId },
        content: 'ช่วยสรุป Spec ของ Feature นี้หน่อย',
      });
      expect(res.status).toBe(201);
      expect(callsOf('chat').map((c) => c.language)).toEqual(['th']);
    });

    test("Choices are drafted in the Raiser's language, else the Organization's", async () => {
      await organizationSpeaks('th');
      const raise = await as(app, beam.id)('POST', '/decision-requests', {
        featureId: SEED.featureId,
        kind: 'BLOCKER',
        title: 'ปุ่ม Retry ควรอยู่ตรงไหน',
        description: 'หน้า order ไม่มีที่สำหรับปุ่ม retry',
      });
      expect(raise.status).toBe(201);
      await personPicks(beam.id, 'en');
      await as(app, beam.id)('POST', '/decision-requests', {
        featureId: SEED.featureId,
        kind: 'QUESTION',
        title: 'Timeout?',
        description: 'How long before a payment fails?',
      });
      expect(callsOf('generateChoices').map((c) => c.language)).toEqual(['th', 'en']);
    });
  });

  describe('Grilling', () => {
    let olga: string;
    let somchai: string;

    async function person(name: string) {
      const user = await db.user.create({
        data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
      });
      await db.orgMembership.create({
        data: { organizationId: SEED.organizationId, userId: user.id, role: 'MEMBER' },
      });
      return user.id;
    }

    async function conversationOf(userId: string): Promise<ConversationView> {
      const inbox = await as(app, userId)<InboxItem[]>('GET', '/inbox');
      const item = inbox.body.find((i) => i.kind === 'ANSWER_GRILLING');
      if (item?.kind !== 'ANSWER_GRILLING' || !item.grilling.conversationId) {
        throw new Error('No Grilling Conversation in the Inbox');
      }
      const res = await as(app, userId)<ConversationView>(
        'GET',
        `/conversations/${item.grilling.conversationId}`,
      );
      return res.body;
    }

    beforeEach(async () => {
      olga = await person('Olga');
      somchai = await person('Somchai');
      const project = await db.project.create({
        data: { organizationId: SEED.organizationId, name: 'Wealth' },
      });
      const team = await db.team.create({ data: { projectId: project.id, name: 'Invest' } });
      await db.teamMembership.create({ data: { teamId: team.id, userId: olga, role: 'PO' } });
      await db.teamMembership.create({ data: { teamId: team.id, userId: somchai, role: 'PO' } });
      await personPicks(somchai, 'th');
      const started = await as(app, olga)<GrillingView>(
        'POST',
        `/projects/${project.id}/grillings`,
      );
      expect(started.status).toBe(201);
    });

    test("questions are drafted in the Organization's language", () => {
      expect(callsOf('grillingQuestions').map((c) => c.language)).toEqual(['en']);
    });

    test("the server's Grilling texts are written in each owner's language", async () => {
      const olgas = await conversationOf(olga);
      const somchais = await conversationOf(somchai);
      const notes = somchais.messages[0]?.grillingNotes ?? [];
      expect(notes.length).toBeGreaterThan(0);
      expect(somchais.messages[0]?.content).toBe(grillingNotesText(notes, 'th'));
      expect(somchais.messages[0]?.content).toContain('นี่คือ Grilling Conversation ของคุณ');
      expect(somchais.messages[0]?.content).toContain('คำถามที่ 1 จาก');
      expect(olgas.messages[0]?.content).toBe(grillingNotesText(notes, 'en'));

      // A reply, and the follow-up the AI is asked for, in the owner's language too.
      const turn = await as(app, somchai)<ConversationTurnView>(
        'POST',
        `/conversations/${somchais.id}/messages`,
        { content: 'คนทั่วไป' },
      );
      expect(turn.status).toBe(201);
      expect(callsOf('grillingFollowUp').map((c) => c.language)).toEqual(['th']);
      const next = await as(app, somchai)<ConversationTurnView>(
        'POST',
        `/conversations/${somchais.id}/messages`,
        { content: 'ข้าม' },
      );
      expect(next.status).toBe(201);
      // "Skip" after a reply records what was said so far, then asks the next question.
      expect(next.body.reply.content).toContain('บันทึกคำตอบข้อ 1 แล้ว');
      expect(next.body.reply.content).toContain('คำถามที่ 2 จาก');
    });
  });
});
