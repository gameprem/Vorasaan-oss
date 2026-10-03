import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import {
  type ConversationList,
  type ConversationTurnView,
  type ConversationView,
  type GrillingView,
  type InboxItem,
  MAX_GRILLING_FOLLOW_UPS,
  type ServerEvent,
} from '@vorasaan/shared';
import type { GrillingAnswerForAi } from '../ai/ai.port.ts';
import { FAKE_GRILLING_TOPICS, type FakeAiPort, fakeFollowUp } from '../ai/fake-ai.port.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim } = SEED.users;
const BUSINESS = FAKE_GRILLING_TOPICS.BUSINESS.map((t) => t.question);
/** Long enough that the fake asks no follow-up. */
const FULL = (n: number) => `A complete answer number ${n} with plenty of detail.`;

describe('Grilling Conversations (0044)', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let bus: EventBus;
  let wealth: { id: string; teamId: string };
  /** Two POs, a Designer and a Tech Lead. */
  let olga: string;
  let paul: string;
  let dana: string;
  let tom: string;
  let events: { userId: string; event: ServerEvent }[];
  let unsubscribe: (() => void)[] = [];

  const asUser = (id: string) => as(app, id);

  async function person(name: string) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: user.id, role: 'MEMBER' },
    });
    return user.id;
  }

  async function join(teamId: string, userId: string, role: TeamRole) {
    await db.teamMembership.create({ data: { teamId, userId, role } });
  }

  async function start(by = olga) {
    const res = await asUser(by)<GrillingView>('POST', `/projects/${wealth.id}/grillings`);
    expect(res.status).toBe(201);
    return res.body;
  }

  /** The user's Grilling Conversation for the round being asked, from their Inbox Item. */
  async function conversationOf(userId: string): Promise<ConversationView> {
    const inbox = await asUser(userId)<InboxItem[]>('GET', '/inbox');
    const item = inbox.body.find((i) => i.kind === 'ANSWER_GRILLING');
    if (item?.kind !== 'ANSWER_GRILLING' || !item.grilling.conversationId) {
      throw new Error('No Grilling Conversation in the Inbox');
    }
    return read(userId, item.grilling.conversationId);
  }

  async function read(userId: string, id: string): Promise<ConversationView> {
    const res = await asUser(userId)<ConversationView>('GET', `/conversations/${id}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function say(userId: string, id: string, content: string) {
    return asUser(userId)<ConversationTurnView>('POST', `/conversations/${id}/messages`, {
      content,
    });
  }

  async function sayOk(userId: string, id: string, content: string) {
    const res = await say(userId, id, content);
    expect(res.status).toBe(201);
    return res.body.reply.content;
  }

  const grilling = async (id: string) =>
    (await asUser(olga)<GrillingView>('GET', `/grillings/${id}`)).body;
  const followUpCalls = () => ai.calls.filter((c) => c.method === 'grillingFollowUp');
  const eventsFor = (userId: string, name: ServerEvent['event']) =>
    events.filter((e) => e.userId === userId && e.event.event === name).map((e) => e.event);

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
    ai.followUpScript.length = 0;
    olga = await person('Olga');
    paul = await person('Paul');
    dana = await person('Dana');
    tom = await person('Tom');
    const project = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const team = await db.team.create({ data: { projectId: project.id, name: 'Invest' } });
    wealth = { id: project.id, teamId: team.id };
    await join(team.id, olga, 'PO');
    await join(team.id, paul, 'PO');
    await join(team.id, dana, 'DESIGNER');
    await join(team.id, tom, 'TECH_LEAD');
    events = [];
    unsubscribe = [olga, paul, dana, tom, pim.id].map((userId) =>
      bus.subscribe(userId, (event) => events.push({ userId, event })),
    );
  });

  afterEach(() => {
    for (const off of unsubscribe) off();
  });

  test('two POs each get their own Conversation; one answers question 1 with a follow-up, the other sees it answered', async () => {
    const g = await start();

    // Each PO has their own Grilling Conversation, linked to the round, pointed to by the Inbox.
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    expect(olgas.id).not.toBe(pauls.id);
    for (const conv of [olgas, pauls]) {
      expect(conv).toMatchObject({
        title: 'Grilling: Business round',
        scope: { kind: 'PROJECT', project: { id: wealth.id, name: 'Wealth' } },
        grilling: { id: g.id, round: 'BUSINESS', role: 'PO' },
        grillingProgress: { grillingStatus: 'RUNNING', roundStatus: 'ASKING', answered: 0 },
      });
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0]?.role).toBe('ASSISTANT');
      expect(conv.messages[0]?.content).toContain(`Question 1 of 4: ${BUSINESS[0]}`);
      expect(conv.grillingProgress?.questions.map((q) => q.status)).toEqual([
        'ASKING',
        'OPEN',
        'OPEN',
        'OPEN',
      ]);
    }
    // Nobody else gets one, and each is listed only for its owner.
    expect(await db.conversation.count()).toBe(2);
    const listed = await asUser(olga)<ConversationList>('GET', '/conversations?recent');
    expect(listed.body.conversations.map((c) => c.id)).toEqual([olgas.id]);
    expect(listed.body.conversations[0]?.grilling).toEqual({
      id: g.id,
      round: 'BUSINESS',
      role: 'PO',
    });
    expect((await conversationOf(olga)).id).toBe(olgas.id);

    // Olga's thin answer gets a follow-up; nothing is recorded yet.
    const first = await say(olga, olgas.id, 'Grow.');
    expect(first.status).toBe(201);
    expect(first.body.reply.content).toBe(fakeFollowUp(BUSINESS[0] ?? '', 0));
    expect(first.body.message.content).toBe('Grow.');
    expect((await grilling(g.id)).rounds[0]?.questions[0]?.answer).toBeNull();
    expect((await read(olga, olgas.id)).grillingProgress?.questions[0]).toMatchObject({
      status: 'ASKING',
      followUpsAsked: 1,
    });

    // Her reply is enough: the answer and its follow-up are recorded, with her name.
    events = [];
    const second = await sayOk(olga, olgas.id, 'Grow monthly active payers to 1.5M by Q4.');
    expect(second).toContain('I recorded your answer to question 1');
    expect(second).toContain(`Question 2 of 4: ${BUSINESS[1]}`);
    const question = (await grilling(g.id)).rounds[0]?.questions[0];
    expect(question).toMatchObject({
      answer: 'Grow.',
      answeredBy: { id: olga, name: 'Olga' },
      followUps: [
        {
          question: fakeFollowUp(BUSINESS[0] ?? '', 0),
          answer: 'Grow monthly active payers to 1.5M by Q4.',
        },
      ],
    });
    expect(eventsFor(olga, 'conversation.done')).toHaveLength(1);

    // Paul's Conversation is told, shows question 1 as answered, and moves on to question 2.
    const appended = eventsFor(paul, 'conversation.appended');
    expect(appended).toHaveLength(1);
    expect(eventsFor(olga, 'conversation.appended')).toEqual([]);
    const paulsNow = await read(paul, pauls.id);
    expect(paulsNow.messages).toHaveLength(2);
    const note = paulsNow.messages[1]?.content ?? '';
    expect(note).toContain('Olga answered question 1 meanwhile');
    expect(note).toContain(`Question 2 of 4: ${BUSINESS[1]}`);
    expect(paulsNow.grillingProgress).toMatchObject({ answered: 1, total: 4 });
    expect(paulsNow.grillingProgress?.questions[0]).toMatchObject({
      status: 'ANSWERED',
      answeredBy: { id: olga, name: 'Olga' },
    });
    expect(paulsNow.grillingProgress?.questions[1]?.status).toBe('ASKING');

    // Question 1 is never asked again: Paul's answer goes to question 2.
    expect(await sayOk(paul, pauls.id, FULL(2))).toContain(`Question 3 of 4: ${BUSINESS[2]}`);
    expect((await grilling(g.id)).rounds[0]?.questions[1]).toMatchObject({
      answer: FULL(2),
      answeredBy: { id: paul },
      followUps: [],
    });
  });

  test('a Grilling Conversation has no model to pick: picking one is a 422 and stores nothing', async () => {
    await start();
    const conv = await conversationOf(olga);
    const res = await asUser(olga)('POST', `/conversations/${conv.id}/messages`, {
      content: FULL(1),
      approvedModelId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(422);
    expect((await read(olga, conv.id)).messages).toHaveLength(1);
  });

  test(`at most ${MAX_GRILLING_FOLLOW_UPS} follow-ups per question, whatever the AI says`, async () => {
    const g = await start();
    const conv = await conversationOf(olga);
    ai.scriptGrillingFollowUps('Which KPI?', 'By how much?', 'And by when?', 'Anything else?');

    expect(await sayOk(olga, conv.id, FULL(1))).toBe('Which KPI?');
    expect(await sayOk(olga, conv.id, 'Payers.')).toBe('By how much?');
    const last = await sayOk(olga, conv.id, 'To 1.5M.');
    expect(last).toContain('I recorded your answer to question 1');
    expect(last).not.toContain('And by when?');
    // The server didn't even ask the AI a third time.
    expect(followUpCalls()).toHaveLength(MAX_GRILLING_FOLLOW_UPS);
    expect(followUpCalls()[1]?.input).toMatchObject({
      answer: FULL(1),
      followUps: [{ question: 'Which KPI?', answer: 'Payers.' }],
      remaining: 1,
    });
    ai.followUpScript.length = 0;

    const q = (await grilling(g.id)).rounds[0]?.questions[0];
    expect(q?.followUps).toEqual([
      { question: 'Which KPI?', answer: 'Payers.' },
      { question: 'By how much?', answer: 'To 1.5M.' },
    ]);
    expect(await db.grillingQuestion.findUnique({ where: { id: q?.id } })).toMatchObject({
      answeredById: olga,
    });
  });

  test('the Brief Proposal input has the follow-up answers, attributed to who gave them', async () => {
    const g = await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    // Olga: question 1, with a follow-up; Paul: the rest, through his own Conversation.
    await sayOk(olga, olgas.id, 'Grow.');
    await sayOk(olga, olgas.id, 'Grow monthly active payers to 1.5M by Q4.');
    for (const n of [2, 3]) await sayOk(paul, pauls.id, FULL(n));
    ai.scriptGrillingFollowUps('Which markets exactly?');
    await sayOk(paul, pauls.id, 'Not crypto.');
    const completing = await sayOk(paul, pauls.id, 'Business accounts and crypto, in Thailand.');
    expect(completing).toContain('I recorded your answer to question 4');
    expect(completing).toContain('the Business round is complete');

    // The UX and technical rounds through the old API (the CLI and the form still work).
    let view = await grilling(g.id);
    expect(view.currentRound).toBe('UX');
    for (const [round, by] of [
      [1, dana],
      [2, tom],
    ] as const) {
      for (const q of view.rounds[round]?.questions ?? []) {
        const res = await asUser(by)('POST', `/grillings/${g.id}/questions/${q.id}/answer`, {
          answer: `Answer to ${q.text}`,
        });
        expect(res.status).toBe(201);
      }
      view = await grilling(g.id);
    }
    expect(view.status).toBe('DRAFTED');

    const draft = ai.calls.find((c) => c.method === 'draftBriefFromGrilling')?.input as {
      answers: GrillingAnswerForAi[];
    };
    expect(draft.answers.slice(0, 4)).toEqual([
      {
        round: 'BUSINESS',
        question: BUSINESS[0] ?? '',
        answer: 'Grow.',
        answeredBy: { name: 'Olga', role: 'PO' },
        followUps: [
          {
            question: fakeFollowUp(BUSINESS[0] ?? '', 0),
            answer: 'Grow monthly active payers to 1.5M by Q4.',
          },
        ],
      },
      expect.objectContaining({ answer: FULL(2), answeredBy: { name: 'Paul', role: 'PO' } }),
      expect.objectContaining({ answer: FULL(3), answeredBy: { name: 'Paul', role: 'PO' } }),
      {
        round: 'BUSINESS',
        question: BUSINESS[3] ?? '',
        answer: 'Not crypto.',
        answeredBy: { name: 'Paul', role: 'PO' },
        followUps: [
          {
            question: 'Which markets exactly?',
            answer: 'Business accounts and crypto, in Thailand.',
          },
        ],
      },
    ]);
    expect(draft.answers[4]).toMatchObject({
      round: 'UX',
      answeredBy: { name: 'Dana', role: 'DESIGNER' },
      followUps: [],
    });
    // The UX round's memory has the follow-ups too.
    const uxQuestions = ai.calls.filter((c) => c.method === 'grillingQuestions')[1]?.input as {
      memory: { rounds: { summary: string }[] };
    };
    expect(uxQuestions.memory.rounds[0]?.summary).toContain('Follow-up:');
    expect(uxQuestions.memory.rounds[0]?.summary).toContain('1.5M by Q4');
    // And the drafted Brief carries them.
    const proposal = await db.briefProposal.findFirstOrThrow({ where: { projectId: wealth.id } });
    expect(proposal.proposedMarkdown).toContain('1.5M by Q4. (Olga, PO)');
  });

  test('the answer that completes a round moves the Grilling on; the other holders are told, and the next round’s holders get theirs', async () => {
    const g = await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    for (const n of [1, 2, 3]) await sayOk(olga, olgas.id, FULL(n));
    events = [];
    const last = await sayOk(olga, olgas.id, FULL(4));
    expect(last).toContain('the Business round is complete');

    const view = await grilling(g.id);
    expect(view.currentRound).toBe('UX');
    expect(view.rounds[0]?.status).toBe('ANSWERED');
    // Paul's Conversation was asking question 4 too: he's told the round is over.
    const paulsNow = await read(paul, pauls.id);
    expect(paulsNow.messages.at(-1)?.content).toContain('the Business round is complete');
    expect(paulsNow.grillingProgress).toMatchObject({ roundStatus: 'ANSWERED', answered: 4 });
    expect(eventsFor(paul, 'conversation.appended')).toHaveLength(1);
    // A message there now gets the same note, and no AI call.
    const calls = ai.calls.length;
    expect(await sayOk(paul, pauls.id, 'One more thing')).toContain('round is complete');
    expect(ai.calls.length).toBe(calls);

    // The Designer's round opens, with her own Conversation; the POs have no Inbox Item left.
    const danas = await conversationOf(dana);
    expect(danas).toMatchObject({ grilling: { id: g.id, round: 'UX', role: 'DESIGNER' } });
    expect(danas.messages[0]?.content).toContain('Question 1 of 3');
    expect((await asUser(olga)<InboxItem[]>('GET', '/inbox')).body).toEqual([]);
  });

  test('answering through the old API marks the question answered in the Conversations', async () => {
    const g = await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    const [q1, q2] = g.rounds[0]?.questions ?? [];

    // Olga is mid-way: her answer got a follow-up she hasn't replied to yet.
    await sayOk(olga, olgas.id, 'Grow.');
    events = [];
    const res = await asUser(paul)('POST', `/grillings/${g.id}/questions/${q1?.id}/answer`, {
      answer: 'Grow payers to 1.5M.',
    });
    expect(res.status).toBe(201);

    for (const [userId, id] of [
      [olga, olgas.id],
      [paul, pauls.id],
    ] as const) {
      const conv = await read(userId, id);
      expect(conv.grillingProgress?.questions[0]).toMatchObject({
        status: 'ANSWERED',
        answeredBy: { id: paul, name: 'Paul' },
      });
      expect(conv.grillingProgress?.questions[1]?.status).toBe('ASKING');
    }
    const olgasNow = await read(olga, olgas.id);
    const note = olgasNow.messages.at(-1)?.content ?? '';
    expect(note).toContain(
      "Paul answered question 1 before you finished, so your reply to it wasn't recorded",
    );
    expect(note).toContain('Grow payers to 1.5M.');
    expect(note).toContain(`Question 2 of 4: ${q2?.text}`);
    // Paul answered through the API, not in his Conversation: it moves on too, without telling
    // him what he did himself.
    const paulsLast = (await read(paul, pauls.id)).messages.at(-1)?.content ?? '';
    expect(paulsLast).toBe(`Question 2 of 4: ${q2?.text}`);
    expect(eventsFor(olga, 'conversation.appended')).toHaveLength(1);
    expect(eventsFor(paul, 'conversation.appended')).toHaveLength(1);

    // Olga's next message answers question 2, not question 1.
    await sayOk(olga, olgas.id, FULL(2));
    expect((await grilling(g.id)).rounds[0]?.questions[1]?.answeredBy?.id).toBe(olga);
    expect((await grilling(g.id)).rounds[0]?.questions[0]).toMatchObject({
      answer: 'Grow payers to 1.5M.',
      followUps: [],
    });
  });

  test('"skip" in English or Thai skips a question, or ends its follow-ups; skipped ones come back later', async () => {
    const g = await start();
    const conv = await conversationOf(olga);

    const skipped = await sayOk(olga, conv.id, 'Skip');
    expect(skipped).toContain('Skipped question 1.');
    expect(skipped).toContain(`Question 2 of 4: ${BUSINESS[1]}`);
    expect(followUpCalls()).toHaveLength(0);

    // A thin answer gets a follow-up; "ข้าม" stops it and records the answer as it is.
    expect(await sayOk(olga, conv.id, 'NPS.')).toBe(fakeFollowUp(BUSINESS[1] ?? '', 0));
    const stopped = await sayOk(olga, conv.id, ' ข้าม ');
    expect(stopped).toContain('I recorded your answer to question 2');
    expect((await grilling(g.id)).rounds[0]?.questions[1]).toMatchObject({
      answer: 'NPS.',
      followUps: [],
    });

    await sayOk(olga, conv.id, FULL(3));
    const done = await sayOk(olga, conv.id, FULL(4));
    expect(done).toContain("That's all I have for you for now. 1 question is still waiting");
    const view = await read(olga, conv.id);
    expect(view.grillingProgress?.questions.map((q) => q.status)).toEqual([
      'SKIPPED',
      'ANSWERED',
      'ANSWERED',
      'ANSWERED',
    ]);
    expect((await grilling(g.id)).currentRound).toBe('BUSINESS');

    // Any message then goes back to the skipped question.
    expect(await sayOk(olga, conv.id, 'ok, back to it')).toContain(
      `Question 1 of 4: ${BUSINESS[0]}`,
    );
    const finished = await sayOk(olga, conv.id, FULL(1));
    expect(finished).toContain('the Business round is complete');
  });

  test('someone who loses the Team Role can no longer answer, in their Conversation or through the API', async () => {
    const g = await start();
    const conv = await conversationOf(paul);
    await db.teamMembership.deleteMany({ where: { userId: paul } });

    const res = await say(paul, conv.id, FULL(1));
    expect(res.status).toBe(403);
    // The message isn't stored, and nothing is recorded.
    expect((await read(paul, conv.id)).messages).toHaveLength(1);
    expect((await asUser(paul)('POST', `/conversations/${conv.id}/retry`)).status).toBe(409);
    const q1 = g.rounds[0]?.questions[0];
    const api = await asUser(paul)('POST', `/grillings/${g.id}/questions/${q1?.id}/answer`, {
      answer: FULL(1),
    });
    expect(api.status).toBe(403);
    expect((await grilling(g.id)).rounds[0]?.questions[0]?.answer).toBeNull();
    // Nor open a new one.
    expect((await asUser(paul)('POST', `/grillings/${g.id}/conversation`)).status).toBe(403);
  });

  test('only the owner reads a Grilling Conversation; others, an Admin included, get 404', async () => {
    await start();
    const conv = await conversationOf(olga);
    for (const other of [paul, pim.id, dana]) {
      expect((await asUser(other)('GET', `/conversations/${conv.id}`)).status).toBe(404);
      expect(
        (await asUser(other)('POST', `/conversations/${conv.id}/messages`, { content: 'hi' }))
          .status,
      ).toBe(404);
    }
  });

  test('POST /grillings/:id/conversation opens one for a holder who has none, once', async () => {
    const g = await start();
    const late = await person('Lara');
    await join(wealth.teamId, late, 'PO');
    // The Inbox shows the round, with no Conversation yet.
    const before = await asUser(late)<InboxItem[]>('GET', '/inbox');
    expect(before.body[0]).toMatchObject({
      kind: 'ANSWER_GRILLING',
      grilling: { id: g.id, conversationId: null },
    });

    // Someone already answered question 1: she starts at question 2.
    const q1 = g.rounds[0]?.questions[0];
    await asUser(olga)('POST', `/grillings/${g.id}/questions/${q1?.id}/answer`, {
      answer: 'x y z w',
    });
    const opened = await asUser(late)<ConversationView>('POST', `/grillings/${g.id}/conversation`);
    expect(opened.status).toBe(201);
    expect(opened.body.messages[0]?.content).toContain('1 of them already have an answer');
    expect(opened.body.messages[0]?.content).toContain(`Question 2 of 4: ${BUSINESS[1]}`);
    const again = await asUser(late)<ConversationView>('POST', `/grillings/${g.id}/conversation`);
    expect(again.body.id).toBe(opened.body.id);
    expect((await conversationOf(late)).id).toBe(opened.body.id);
    // Deleted, it can be opened again.
    expect((await asUser(late)('DELETE', `/conversations/${opened.body.id}`)).status).toBe(204);
    const reopened = await asUser(late)<ConversationView>(
      'POST',
      `/grillings/${g.id}/conversation`,
    );
    expect(reopened.body.id).not.toBe(opened.body.id);

    // Not for someone without the round's Team Role, nor once it isn't running.
    expect((await asUser(dana)('POST', `/grillings/${g.id}/conversation`)).status).toBe(403);
    expect((await asUser(olga)('POST', `/grillings/${g.id}/cancel`)).status).toBe(201);
    expect((await asUser(late)('POST', `/grillings/${g.id}/conversation`)).status).toBe(409);
  });

  test('a skipped round or a cancelled Grilling closes the Conversations', async () => {
    const g = await start();
    const olgas = await conversationOf(olga);
    const skip = await asUser(olga)('POST', `/grillings/${g.id}/skip-round`, { round: 'BUSINESS' });
    expect(skip.status).toBe(201);
    expect((await read(olga, olgas.id)).messages.at(-1)?.content).toContain(
      'The Business round was skipped',
    );
    expect((await read(olga, olgas.id)).grillingProgress?.questions.map((q) => q.status)).toEqual([
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
    ]);

    const danas = await conversationOf(dana);
    expect((await asUser(olga)('POST', `/grillings/${g.id}/cancel`)).status).toBe(201);
    expect((await read(dana, danas.id)).messages.at(-1)?.content).toContain(
      'This Grilling was cancelled',
    );
    // Told once.
    await asUser(olga)('POST', `/grillings/${g.id}/cancel`);
    expect((await read(dana, danas.id)).messages).toHaveLength(2);
  });

  test('an AI failure saves nothing of the turn and answers 502; retry goes on', async () => {
    const g = await start();
    const conv = await conversationOf(olga);

    // The follow-up decision fails.
    ai.scriptGrillingFollowUps(new Error('provider down'));
    const failed = await say(olga, conv.id, 'Grow.');
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ conversationId: conv.id });
    expect(eventsFor(olga, 'conversation.failed')).toHaveLength(1);
    let view = await read(olga, conv.id);
    expect(view.messages.map((m) => m.role)).toEqual(['ASSISTANT', 'USER']);
    expect(view.grillingProgress?.questions[0]).toMatchObject({
      status: 'ASKING',
      followUpsAsked: 0,
    });
    const retried = await asUser(olga)<ConversationTurnView>(
      'POST',
      `/conversations/${conv.id}/retry`,
    );
    expect(retried.status).toBe(201);
    expect(retried.body.reply.content).toBe(fakeFollowUp(BUSINESS[0] ?? '', 0));

    // The answer that completes the round fails to move it on: not even it is saved.
    await sayOk(olga, conv.id, FULL(1));
    for (const n of [2, 3]) await sayOk(olga, conv.id, FULL(n));
    const original = ai.grillingQuestions.bind(ai);
    ai.grillingQuestions = async () => {
      throw new Error('provider down');
    };
    try {
      const res = await say(olga, conv.id, FULL(4));
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ conversationId: conv.id });
    } finally {
      ai.grillingQuestions = original;
    }
    const before = await grilling(g.id);
    expect(before.currentRound).toBe('BUSINESS');
    expect(before.rounds[0]?.questions[3]?.answer).toBeNull();
    view = await read(olga, conv.id);
    expect(view.messages.at(-1)?.role).toBe('USER');

    const again = await asUser(olga)<ConversationTurnView>(
      'POST',
      `/conversations/${conv.id}/retry`,
    );
    expect(again.status).toBe(201);
    expect(again.body.reply.content).toContain('the Business round is complete');
    expect((await grilling(g.id)).currentRound).toBe('UX');
  });

  test('when someone else answers the last question and closes the round, the other holder is told who answered it', async () => {
    await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    for (const n of [1, 2, 3]) await sayOk(olga, olgas.id, FULL(n));
    expect((await read(paul, pauls.id)).grillingProgress?.questions[3]?.status).toBe('ASKING');

    // Olga answers the question Paul was asked, which completes the round.
    await sayOk(olga, olgas.id, FULL(41));
    const told = (await read(paul, pauls.id)).messages.at(-1)?.content ?? '';
    expect(told).toContain('answered question 4 meanwhile');
    expect(told).toContain('the Business round is complete');
  });

  test('two holders answering the last question at once: one answer counts, and the round moves on once', async () => {
    const g = await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    // Both Conversations reach question 4 with the first three answered.
    for (const n of [1, 2, 3]) await sayOk(olga, olgas.id, FULL(n));
    const paulsNow = await read(paul, pauls.id);
    expect(paulsNow.grillingProgress?.questions[3]?.status).toBe('ASKING');

    const results = await Promise.all([
      say(olga, olgas.id, FULL(41)),
      say(paul, pauls.id, FULL(42)),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const view = await grilling(g.id);
    expect(view.currentRound).toBe('UX');
    expect([FULL(41), FULL(42)]).toContain(view.rounds[0]?.questions[3]?.answer ?? '');
    expect(await db.grillingRound.count({ where: { grillingId: g.id, kind: 'UX' } })).toBe(1);
    const replies = results.map((r) => r.body.reply.content).join('\n');
    expect(replies).toContain("so your reply to it wasn't recorded");
  });
});
