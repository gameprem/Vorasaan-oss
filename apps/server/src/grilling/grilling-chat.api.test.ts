import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import {
  type ActionCardView,
  type ConversationList,
  type ConversationTurnView,
  type ConversationView,
  type GrillingView,
  grillingNotesText,
  type InboxItem,
  type ProjectBriefView,
  type ServerEvent,
} from '@vorasaan/shared';
import { FAKE_GRILLING_TOPICS, type FakeAiPort, fakeFollowUp } from '../ai/fake-ai.port.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim } = SEED.users;
const BUSINESS = FAKE_GRILLING_TOPICS.BUSINESS.map((t) => t.question);
/** Long enough that the fake asks no follow-up. */
const FULL = (n: number) => `A complete answer number ${n} with plenty of detail.`;

// Ticket 0047: what the web's Grilling chat reads from the server. Grilling Notes on
// every server-written message, the rounds and answers in the progress, and the Brief
// Proposal as an Action Card in the starter's Conversation.
describe('Grilling in the chat view (0047)', () => {
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

  async function start(by = olga, projectId = wealth.id) {
    const res = await asUser(by)<GrillingView>('POST', `/projects/${projectId}/grillings`);
    expect(res.status).toBe(201);
    return res.body;
  }

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
    const res = await asUser(userId)<ConversationTurnView>(
      'POST',
      `/conversations/${id}/messages`,
      { content },
    );
    expect(res.status).toBe(201);
    return res.body;
  }

  /** Answers every open question of the current round through the Grilling API. */
  async function answerRoundByApi(grillingId: string, by: string) {
    const view = (await asUser(by)<GrillingView>('GET', `/grillings/${grillingId}`)).body;
    const round = view.rounds.find((r) => r.status === 'ASKING');
    for (const q of round?.questions ?? []) {
      if (q.answer !== null) continue;
      const res = await asUser(by)('POST', `/grillings/${grillingId}/questions/${q.id}/answer`, {
        answer: `Answer to ${q.text}`,
      });
      expect(res.status).toBe(201);
    }
  }

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

  test('every server-written message carries its Grilling Notes; its content is them in English', async () => {
    await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);

    // The introduction and the first question.
    const opening = olgas.messages[0];
    expect(opening?.grillingNotes).toEqual([
      { kind: 'INTRO', round: 'BUSINESS', role: 'PO', total: 4, answered: 0, maxFollowUps: 2 },
      { kind: 'ASK', position: 0, total: 4, text: BUSINESS[0] ?? '' },
    ]);
    expect(opening?.content).toBe(grillingNotesText(opening?.grillingNotes ?? [], 'en'));
    expect(opening?.content).toContain(`Question 1 of 4: ${BUSINESS[0]}`);

    // A follow-up is the AI's own words, numbered.
    const thin = await say(olga, olgas.id, 'Grow.');
    expect(thin.message.grillingNotes).toBeNull();
    expect(thin.reply.grillingNotes).toEqual([
      { kind: 'FOLLOW_UP', number: 1, text: fakeFollowUp(BUSINESS[0] ?? '', 0) },
    ]);
    expect(thin.reply.content).toBe(fakeFollowUp(BUSINESS[0] ?? '', 0));

    // Recorded, then the next question.
    const done = await say(olga, olgas.id, FULL(1));
    expect(done.reply.grillingNotes).toEqual([
      { kind: 'RECORDED', position: 0 },
      { kind: 'ASK', position: 1, total: 4, text: BUSINESS[1] ?? '' },
    ]);
    expect(done.reply.content).toBe(
      `Thanks, I recorded your answer to question 1.\n\nQuestion 2 of 4: ${BUSINESS[1]}`,
    );

    // Paul's Conversation is told who answered, as a notice, then asked the next question.
    const appended = eventsFor(paul, 'conversation.appended');
    expect(appended).toHaveLength(1);
    const notice = appended[0]?.event === 'conversation.appended' ? appended[0].data : null;
    expect(notice?.messages[0]?.grillingNotes).toEqual([
      { kind: 'ANSWERED_ELSEWHERE', position: 0, by: 'Olga', answer: 'Grow.', hadReply: false },
      { kind: 'ASK', position: 1, total: 4, text: BUSINESS[1] ?? '' },
    ]);
    expect(notice?.messages[0]?.content).toContain('Olga answered question 1 meanwhile');

    // A skip.
    const skipped = await say(paul, pauls.id, 'skip');
    expect(skipped.reply.grillingNotes).toEqual([
      { kind: 'SKIPPED', position: 1 },
      { kind: 'ASK', position: 2, total: 4, text: BUSINESS[2] ?? '' },
    ]);
  });

  test('the progress has the three rounds and the answers others gave, with their follow-ups', async () => {
    const g = await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    expect(olgas.grillingProgress?.rounds).toEqual([
      { kind: 'BUSINESS', role: 'PO', status: 'ASKING', answered: 0, total: 4 },
      { kind: 'UX', role: 'DESIGNER', status: 'UPCOMING', answered: 0, total: 0 },
      { kind: 'TECHNICAL', role: 'TECH_LEAD', status: 'UPCOMING', answered: 0, total: 0 },
    ]);

    await say(olga, olgas.id, 'Grow.');
    await say(olga, olgas.id, FULL(1));
    const seen = await read(paul, pauls.id);
    expect(seen.grillingProgress?.rounds[0]).toMatchObject({ answered: 1, total: 4 });
    expect(seen.grillingProgress?.questions[0]).toMatchObject({
      status: 'ANSWERED',
      answeredBy: { id: olga, name: 'Olga' },
      answer: 'Grow.',
      followUps: [{ question: fakeFollowUp(BUSINESS[0] ?? '', 0), answer: FULL(1) }],
    });
    // Nothing of an unanswered question, even one being answered elsewhere.
    expect(seen.grillingProgress?.questions[1]).toMatchObject({ answer: null, followUps: [] });

    // The round ends; the UX round opens and the header follows it from any Conversation.
    for (const n of [2, 3, 4]) await say(paul, pauls.id, FULL(n));
    expect((await read(olga, olgas.id)).grillingProgress?.rounds).toEqual([
      { kind: 'BUSINESS', role: 'PO', status: 'ANSWERED', answered: 4, total: 4 },
      {
        kind: 'UX',
        role: 'DESIGNER',
        status: 'ASKING',
        answered: 0,
        total: FAKE_GRILLING_TOPICS.UX.length,
      },
      { kind: 'TECHNICAL', role: 'TECH_LEAD', status: 'UPCOMING', answered: 0, total: 0 },
    ]);
    const danas = await conversationOf(dana);
    expect(danas.grilling).toEqual({ id: g.id, round: 'UX', role: 'DESIGNER' });
    expect(danas.grillingProgress?.rounds[1]?.status).toBe('ASKING');
    // Olga's own Conversation was told who answered the question it asked, then closed.
    const closing = (await read(olga, olgas.id)).messages.at(-1);
    expect(closing?.grillingNotes).toEqual([
      { kind: 'ANSWERED_ELSEWHERE', position: 3, by: 'Paul', answer: FULL(4), hadReply: false },
      { kind: 'CLOSED', round: 'BUSINESS', reason: 'COMPLETE' },
    ]);
  });

  test("the Brief Proposal is an Action Card in the starter's Grilling Conversation, and approving it writes the Brief", async () => {
    const g = await start();
    const olgas = await conversationOf(olga);
    const pauls = await conversationOf(paul);
    await say(olga, olgas.id, FULL(1));
    for (const n of [2, 3, 4]) await say(paul, pauls.id, FULL(n));
    const danas = await conversationOf(dana);
    for (const n of FAKE_GRILLING_TOPICS.UX.keys()) await say(dana, danas.id, FULL(n));
    events = [];
    await answerRoundByApi(g.id, tom);
    expect((await asUser(olga)<GrillingView>('GET', `/grillings/${g.id}`)).body.status).toBe(
      'DRAFTED',
    );
    const proposal = await db.briefProposal.findFirstOrThrow({ where: { projectId: wealth.id } });

    // In Olga's Business Conversation (her latest of this Grilling): a message and its card.
    const view = await read(olga, olgas.id);
    const note = view.messages.at(-1);
    expect(note?.role).toBe('ASSISTANT');
    expect(note?.grillingNotes).toEqual([{ kind: 'BRIEF_DRAFTED', project: 'Wealth' }]);
    expect(note?.content).toContain('I drafted a Brief Proposal for Wealth');
    expect(view.actionCards).toHaveLength(1);
    const card = view.actionCards[0] as ActionCardView;
    expect(card).toMatchObject({
      conversationId: olgas.id,
      messageId: note?.id,
      kind: 'BRIEF_PROPOSAL',
      targetId: proposal.id,
      status: 'PROPOSED',
      title: 'Change the Project Brief of "Wealth"',
      detail: { kind: 'BRIEF_PROPOSAL', approver: { id: olga, name: 'Olga' }, baseVersion: null },
    });
    // Nobody else gets one; no new Conversation was opened.
    expect(await db.actionCard.count()).toBe(1);
    expect(await db.conversation.count({ where: { grillingRoundId: null } })).toBe(0);

    // Olga is told live: the message, then the card.
    const appended = eventsFor(olga, 'conversation.appended');
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      data: { conversationId: olgas.id, messages: [{ id: note?.id }] },
    });
    expect(eventsFor(olga, 'conversation.actionCard.created')).toMatchObject([
      { data: { conversationId: olgas.id, card: { id: card.id, status: 'PROPOSED' } } },
    ]);
    expect(eventsFor(paul, 'conversation.actionCard.created')).toEqual([]);

    // Only Olga sees the card; she approves it, and the Brief gets its first version.
    expect((await asUser(paul)('POST', `/action-cards/${card.id}/approve`)).status).toBe(404);
    const approved = await asUser(olga)<ActionCardView>(
      'POST',
      `/action-cards/${card.id}/approve`,
      {},
    );
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'APPROVED', detail: { version: 1 } });
    const brief = await asUser(olga)<ProjectBriefView>('GET', `/projects/${wealth.id}/brief`);
    expect(brief.body.version).toBe(1);
    expect(brief.body.markdown).toContain('## From Grilling');
  });

  test('a starter with no Grilling Conversation gets the card in a new Project Conversation; approving elsewhere makes it stale', async () => {
    // Pim, an Admin outside the Project's Teams, starts it: she answers no round.
    const g = await start(pim.id);
    const olgas = await conversationOf(olga);
    for (const n of [1, 2, 3, 4]) await say(olga, olgas.id, FULL(n));
    await answerRoundByApi(g.id, dana);
    await answerRoundByApi(g.id, tom);

    const listed = await asUser(pim.id)<ConversationList>('GET', '/conversations');
    expect(listed.body.conversations).toHaveLength(1);
    const item = listed.body.conversations[0];
    expect(item).toMatchObject({
      title: 'Brief Proposal for Wealth',
      scope: { kind: 'PROJECT', project: { id: wealth.id } },
      grilling: null,
    });
    const view = await read(pim.id, item?.id ?? '');
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]?.grillingNotes).toEqual([{ kind: 'BRIEF_DRAFTED', project: 'Wealth' }]);
    expect(view.actionCards).toMatchObject([
      { kind: 'BRIEF_PROPOSAL', status: 'PROPOSED', messageId: view.messages[0]?.id },
    ]);
    // Olga's Conversations got none.
    expect((await read(olga, olgas.id)).actionCards).toEqual([]);

    // Approved from the Inbox's page instead: the card can no longer be approved.
    const proposalId = view.actionCards[0]?.targetId;
    expect((await asUser(pim.id)('POST', `/brief-proposals/${proposalId}/approve`)).status).toBe(
      201,
    );
    expect((await read(pim.id, view.id)).actionCards[0]?.status).toBe('STALE');
  });

  test('a Grilling with nobody to ask drafts its Brief at once, with the card for its starter', async () => {
    const project = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Empty' },
    });
    const g = await start(pim.id, project.id);
    expect(g.status).toBe('DRAFTED');
    const listed = await asUser(pim.id)<ConversationList>('GET', '/conversations');
    expect(listed.body.conversations.map((c) => c.title)).toEqual(['Brief Proposal for Empty']);
    const created = eventsFor(pim.id, 'conversation.actionCard.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      data: { card: { kind: 'BRIEF_PROPOSAL', detail: { approver: { id: pim.id } } } },
    });
  });
});
