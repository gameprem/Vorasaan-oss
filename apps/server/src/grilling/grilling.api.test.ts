import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { BriefVersionView, GrillingView, InboxItem, ServerEvent } from '@vorasaan/shared';
import { AiOutputError, type ContextBlock, type GrillingAnswerForAi } from '../ai/ai.port.ts';
import { FAKE_GRILLING_TOPICS, type FakeAiPort } from '../ai/fake-ai.port.ts';
import type { WorkflowMemory } from '../ai/workflow-memory.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

type QuestionsInput = {
  round: string;
  role: TeamRole;
  projectContext: ContextBlock[];
  guidelines: { title: string }[];
  memory: WorkflowMemory;
};
type DraftInput = {
  briefMarkdown: string;
  projectContext: ContextBlock[];
  memory: WorkflowMemory;
  answers: GrillingAnswerForAi[];
};

describe('Grilling', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let bus: EventBus;
  /** A fresh Project with a PO (Olga), a Designer (Dana) and a Tech Lead (Tom). */
  let wealth: { id: string; teamId: string };
  let olga: string;
  let dana: string;
  let tom: string;
  let events: { userId: string; event: ServerEvent }[];
  let unsubscribe: (() => void)[] = [];

  const asUser = (id: string) => as(app, id);
  const questionCalls = () =>
    ai.calls.filter((c) => c.method === 'grillingQuestions').map((c) => c.input as QuestionsInput);
  const draftCalls = () =>
    ai.calls.filter((c) => c.method === 'draftBriefFromGrilling').map((c) => c.input as DraftInput);

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

  async function start(projectId: string, by: string) {
    return asUser(by)<GrillingView>('POST', `/projects/${projectId}/grillings`);
  }

  function current(g: GrillingView) {
    const round = g.rounds.find((r) => r.kind === g.currentRound);
    if (!round) throw new Error(`No current round in ${g.status} Grilling`);
    return round;
  }

  /** Answers every open question of the current round as `by`; returns the last response. */
  async function answerRound(g: GrillingView, by: string) {
    let last = { status: 0, body: g };
    for (const q of current(g).questions.filter((x) => !x.answer)) {
      last = await asUser(by)<GrillingView>('POST', `/grillings/${g.id}/questions/${q.id}/answer`, {
        answer: `Answer to "${q.text}"`,
      });
      expect(last.status).toBe(201);
    }
    return last.body;
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
    olga = await person('Olga');
    dana = await person('Dana');
    tom = await person('Tom');
    const project = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const team = await db.team.create({ data: { projectId: project.id, name: 'Invest' } });
    wealth = { id: project.id, teamId: team.id };
    await join(team.id, olga, 'PO');
    await join(team.id, dana, 'DESIGNER');
    await join(team.id, tom, 'TECH_LEAD');
    await join(team.id, beam.id, 'BACKEND');
    events = [];
    unsubscribe = [pim.id, beam.id, olga, dana, tom].map((userId) =>
      bus.subscribe(userId, (event) => events.push({ userId, event })),
    );
  });

  afterEach(() => {
    for (const off of unsubscribe) off();
  });

  const inboxChangedFor = () =>
    new Set(events.filter((e) => e.event.event === 'inbox.changed').map((e) => e.userId));

  test('new Project: three rounds answered by the PO, Designer and Tech Lead → proposal → approve → Brief v1 (GRILLING)', async () => {
    const started = await start(wealth.id, olga);
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      projectId: wealth.id,
      status: 'RUNNING',
      startedBy: { id: olga },
      currentRound: 'BUSINESS',
      proposal: null,
      canAnswer: true,
      canManage: true,
    });
    expect(started.body.rounds.map((r) => [r.kind, r.role, r.status])).toEqual([
      ['BUSINESS', 'PO', 'ASKING'],
      ['UX', 'DESIGNER', 'PENDING'],
      ['TECHNICAL', 'TECH_LEAD', 'PENDING'],
    ]);
    const business = current(started.body).questions;
    expect(business.map((q) => q.text)).toEqual(
      FAKE_GRILLING_TOPICS.BUSINESS.map((t) => t.question),
    );
    expect(inboxChangedFor()).toEqual(new Set([olga]));

    // The PO is asked, in the Inbox and in `awaiting=me`; the Designer is not, yet.
    const inbox = await asUser(olga)<InboxItem[]>('GET', '/inbox');
    expect(inbox.body).toEqual([
      expect.objectContaining({
        kind: 'ANSWER_GRILLING',
        project: { id: wealth.id, name: 'Wealth' },
        grilling: {
          id: started.body.id,
          round: 'BUSINESS',
          role: 'PO',
          unanswered: 4,
          // Her Grilling Conversation for the round (0044).
          conversationId: expect.any(String),
        },
      }),
    ]);
    const awaiting = await asUser(olga)<GrillingView[]>('GET', '/grillings?awaiting=me');
    expect(awaiting.body.map((g) => g.id)).toEqual([started.body.id]);
    expect((await asUser(dana)<GrillingView[]>('GET', '/grillings?awaiting=me')).body).toEqual([]);
    expect((await asUser(dana)<InboxItem[]>('GET', '/inbox')).body).toEqual([]);
    expect(
      (await asUser(dana)<GrillingView>('GET', `/grillings/${started.body.id}`)).body,
    ).toMatchObject({ canAnswer: false, canManage: false });

    events = [];
    const afterBusiness = await answerRound(started.body, olga);
    expect(afterBusiness.currentRound).toBe('UX');
    expect(afterBusiness.rounds[0]?.status).toBe('ANSWERED');
    expect(afterBusiness.rounds[0]?.questions.every((q) => q.answeredBy?.id === olga)).toBe(true);
    // The round's end reaches the PO (item gone) and the Designers (new item).
    expect(inboxChangedFor()).toEqual(new Set([olga, dana]));
    expect((await asUser(olga)<InboxItem[]>('GET', '/inbox')).body).toEqual([]);
    expect((await asUser(dana)<InboxItem[]>('GET', '/inbox')).body[0]).toMatchObject({
      kind: 'ANSWER_GRILLING',
      grilling: { round: 'UX', role: 'DESIGNER', unanswered: 3 },
    });

    // The UX round's AI call remembers the business round as a short summary.
    const uxCall = questionCalls()[1];
    expect(uxCall?.round).toBe('UX');
    expect(uxCall?.role).toBe('DESIGNER');
    expect(uxCall?.memory.rounds).toHaveLength(1);
    expect(uxCall?.memory.rounds[0]?.summary).toContain(
      'What business goals should this Project serve?',
    );

    const afterUx = await answerRound(afterBusiness, dana);
    expect(afterUx.currentRound).toBe('TECHNICAL');
    events = [];
    const drafted = await answerRound(afterUx, tom);
    expect(drafted).toMatchObject({
      status: 'DRAFTED',
      currentRound: null,
      proposal: { status: 'PENDING', resultVersion: null },
    });
    expect(inboxChangedFor()).toEqual(new Set([tom, olga]));

    const draft = draftCalls();
    expect(draft).toHaveLength(1);
    expect(draft[0]?.answers).toHaveLength(10);
    expect(draft[0]?.memory.rounds).toHaveLength(3);
    expect(draft[0]?.briefMarkdown).toContain('## Business goals');

    const proposalId = drafted.proposal?.id as string;
    const olgaInbox = await asUser(olga)<InboxItem[]>('GET', '/inbox');
    expect(olgaInbox.body).toEqual([
      expect.objectContaining({
        kind: 'APPROVE_BRIEF_PROPOSAL',
        project: { id: wealth.id, name: 'Wealth' },
        briefProposal: { id: proposalId, source: 'GRILLING' },
      }),
    ]);
    // The starter is the approver: the Admin can't approve it for her.
    expect((await asUser(pim.id)('POST', `/brief-proposals/${proposalId}/approve`)).status).toBe(
      403,
    );
    const approved = await asUser(olga)<BriefVersionView>(
      'POST',
      `/brief-proposals/${proposalId}/approve`,
    );
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({
      projectId: wealth.id,
      version: 1,
      source: 'GRILLING',
      summary: 'Drafted from 10 answers.',
      approvedBy: { id: olga },
    });
    expect(approved.body.markdown).toContain('Answer to "Which KPIs tell you it is working?"');
    const after = await asUser(olga)<GrillingView>('GET', `/grillings/${started.body.id}`);
    expect(after.body.proposal).toMatchObject({ status: 'APPROVED', resultVersion: 1 });
    // Once drafted, a new Grilling may start (to re-run it later).
    expect((await start(wealth.id, olga)).status).toBe(201);
  });

  test('existing Project: the Brief, Features, Specs, Attachments and Guidelines reach the AI, and fewer questions are asked', async () => {
    // The seeded Project: Pim is its PO; its Feature "Async checkout" has Spec v1.
    const seededTeam = SEED.teamId;
    await join(seededTeam, dana, 'DESIGNER');
    const brief = await asUser(pim.id)<BriefVersionView>(
      'POST',
      `/projects/${SEED.projectId}/brief-versions`,
      { markdown: '# Project Brief\n\n## Business goals\nGrow mobile payments.\n', baseVersion: 0 },
    );
    expect(brief.status).toBe(201);
    await db.feature.create({
      data: { teamId: seededTeam, title: 'Card freeze', description: 'Freeze a lost card.' },
    });
    await db.attachment.create({
      data: {
        projectId: SEED.projectId,
        source: 'FILE',
        title: 'Product handbook',
        snapshotText:
          'Target users: retail customers. KPI: weekly active payers.\n' +
          'User journey: pay a bill in two taps. Platform: iOS and Android. Accessibility: WCAG AA.',
        snapshotAt: new Date(),
        addedById: pim.id,
      },
    });
    // The CLI sends a Repo Scan twice: only the newest one exists, and reaches the AI.
    for (const commitSha of ['1111111', '2222222']) {
      const scan = await asUser(pim.id)('POST', `/projects/${SEED.projectId}/repo-scans`, {
        markdown: `# mobile-bank @ ${commitSha}\n\nModules: payments, cards.`,
        repoName: 'mobile-bank',
        commitSha,
      });
      expect(scan.status).toBe(201);
    }
    // Another Project's material never reaches this Project's Grilling.
    await db.attachment.create({
      data: {
        projectId: wealth.id,
        source: 'FILE',
        title: 'Wealth secrets',
        snapshotText: 'OTHER-PROJECT-SECRET non-goal',
        snapshotAt: new Date(),
        addedById: pim.id,
      },
    });
    const guidelines = await asUser(pim.id)('PUT', '/settings/feature-guidelines', {
      criteria: [
        { title: 'Serves a KPI', description: 'Name the KPI.', kind: 'KPI', required: true },
      ],
    });
    expect(guidelines.status).toBe(200);

    const started = await start(SEED.projectId, pim.id);
    expect(started.status).toBe(201);
    const [businessCall] = questionCalls();
    const context = businessCall?.projectContext ?? [];
    // The Brief first, then the Features (with their latest Spec), then the Attachment.
    expect(context[0]).toMatchObject({
      source: { kind: 'BRIEF_VERSION', title: 'Project Brief', version: 1 },
    });
    const titles = context.map((b) => b.source.title);
    expect(titles).toContain('Spec: Async checkout');
    expect(titles).toContain('Feature: Card freeze');
    expect(titles).toContain('Product handbook');
    expect(titles).toContain('Repo Scan: mobile-bank @ 2222222');
    expect(titles).not.toContain('Repo Scan: mobile-bank @ 1111111');
    expect(titles).not.toContain('Wealth secrets');
    expect(JSON.stringify(context)).not.toContain('OTHER-PROJECT-SECRET');
    expect(context.find((b) => b.source.title === 'Spec: Async checkout')?.text).toContain(
      '# Async checkout',
    );
    expect(businessCall?.guidelines.map((g) => g.title)).toEqual(['Serves a KPI']);

    // Business goals, KPIs and target users are known: only non-goals are asked.
    const business = current(started.body);
    expect(business.questions.map((q) => q.text)).toEqual([
      'What is deliberately out of scope (non-goals)?',
    ]);
    expect(business.questions.length).toBeLessThan(FAKE_GRILLING_TOPICS.BUSINESS.length);

    const drafted = await answerRound(started.body, pim.id);
    // UX is fully covered by the handbook; nobody is a Tech Lead in this Project.
    expect(drafted.status).toBe('DRAFTED');
    expect(drafted.rounds.map((r) => [r.kind, r.status, r.skipReason])).toEqual([
      ['BUSINESS', 'ANSWERED', null],
      ['UX', 'SKIPPED', 'NOTHING_TO_ASK'],
      ['TECHNICAL', 'SKIPPED', 'NO_ONE_WITH_ROLE'],
    ]);
    // The TECHNICAL round never reached the AI.
    expect(questionCalls().map((c) => c.round)).toEqual(['BUSINESS', 'UX']);
    const [draft] = draftCalls();
    expect(draft?.briefMarkdown).toBe(
      '# Project Brief\n\n## Business goals\nGrow mobile payments.\n',
    );
    // The whole Brief is the base, so it is not repeated in the context.
    expect(draft?.projectContext.some((b) => b.source.kind === 'BRIEF_VERSION')).toBe(false);
    expect(draft?.answers).toEqual([
      {
        round: 'BUSINESS',
        question: 'What is deliberately out of scope (non-goals)?',
        answer: 'Answer to "What is deliberately out of scope (non-goals)?"',
        answeredBy: { name: 'Pim', role: 'PO' },
        followUps: [],
      },
    ]);
    expect(draft?.memory.rounds.map((r) => r.summary)).toEqual([
      expect.stringContaining('non-goals'),
      expect.stringContaining('nothing was asked'),
      expect.stringContaining('TECH_LEAD'),
    ]);
    // The proposal is drafted on v1 and approved as v2.
    const approved = await asUser(pim.id)<BriefVersionView>(
      'POST',
      `/brief-proposals/${drafted.proposal?.id}/approve`,
    );
    expect(approved.body).toMatchObject({ version: 2, source: 'GRILLING' });
  });

  test('only people with the round’s Team Role answer; only Project editors start', async () => {
    const g = (await start(wealth.id, olga)).body;
    const q = current(g).questions[0];
    const answer = (by: string, id = q?.id) =>
      asUser(by)('POST', `/grillings/${g.id}/questions/${id}/answer`, { answer: 'Mine' });
    expect((await answer(dana)).status).toBe(403);
    expect((await answer(beam.id)).status).toBe(403);
    // An Admin who isn't a PO of this Project doesn't answer the business round either.
    expect((await answer(pim.id)).status).toBe(403);
    const outsider = await db.user.create({
      data: { email: 'out@else.test', name: 'Out', passwordHash: 'x' },
    });
    expect((await answer(outsider.id)).status).toBe(403);
    expect((await asUser(outsider.id)('GET', `/grillings/${g.id}`)).status).toBe(403);
    // A PO of another Project's Team is not a PO here.
    const seededPo = await person('Pat');
    await join(SEED.teamId, seededPo, 'PO');
    expect((await answer(seededPo)).status).toBe(403);
    expect(await db.grillingQuestion.count({ where: { answeredAt: { not: null } } })).toBe(0);

    expect((await answer(olga)).status).toBe(201);
    expect((await answer(olga)).status).toBe(409);
    expect((await answer(olga, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    const empty = await asUser(olga)('POST', `/grillings/${g.id}/questions/${q?.id}/answer`, {
      answer: '  ',
    });
    expect(empty.status).toBe(400);

    // Starting: the Project's POs and Admins only.
    for (const who of [dana, tom, beam.id]) {
      expect((await start(wealth.id, who)).status).toBe(403);
    }
    expect((await start(wealth.id, pim.id)).status).toBe(409);
    expect((await asUser(olga)('GET', '/grillings')).status).toBe(400);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await asUser(olga)('GET', `/grillings/${unknown}`)).status).toBe(404);
    expect((await start(unknown, pim.id)).status).toBe(404);
  });

  test('the starter skips a round; a later answer in the skipped round is refused', async () => {
    const g = (await start(wealth.id, olga)).body;
    const [first, second] = current(g).questions;
    await asUser(olga)('POST', `/grillings/${g.id}/questions/${first?.id}/answer`, {
      answer: 'Grow assets under management.',
    });
    // Only the starter (or an Admin) skips, and only the current round.
    expect(
      (await asUser(dana)('POST', `/grillings/${g.id}/skip-round`, { round: 'BUSINESS' })).status,
    ).toBe(403);
    const otherPo = await person('Pia');
    await join(wealth.teamId, otherPo, 'PO');
    expect(
      (await asUser(otherPo)('POST', `/grillings/${g.id}/skip-round`, { round: 'BUSINESS' }))
        .status,
    ).toBe(403);
    expect(
      (await asUser(olga)('POST', `/grillings/${g.id}/skip-round`, { round: 'UX' })).status,
    ).toBe(409);

    const skipped = await asUser(olga)<GrillingView>('POST', `/grillings/${g.id}/skip-round`, {
      round: 'BUSINESS',
    });
    expect(skipped.status).toBe(201);
    expect(skipped.body.currentRound).toBe('UX');
    expect(skipped.body.rounds[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'BY_STARTER' });
    const qs = skipped.body.rounds[0]?.questions ?? [];
    expect(qs.filter((q) => q.skipped)).toHaveLength(3);
    expect(qs.find((q) => q.id === first?.id)).toMatchObject({
      skipped: false,
      answer: 'Grow assets under management.',
    });
    // The partial answers still reach the next round's memory.
    expect(questionCalls()[1]?.memory.rounds[0]?.summary).toContain(
      'Grow assets under management.',
    );
    const late = await asUser(otherPo)(
      'POST',
      `/grillings/${g.id}/questions/${second?.id}/answer`,
      {
        answer: 'Too late',
      },
    );
    expect(late.status).toBe(409);

    // An Admin may skip too.
    const byAdmin = await asUser(pim.id)<GrillingView>('POST', `/grillings/${g.id}/skip-round`, {
      round: 'UX',
    });
    expect(byAdmin.body.currentRound).toBe('TECHNICAL');
  });

  test('cancelling writes no Brief Version, before or after the draft; then a new Grilling may start', async () => {
    const g = (await start(wealth.id, olga)).body;
    events = [];
    expect((await asUser(dana)('POST', `/grillings/${g.id}/cancel`)).status).toBe(403);
    const cancelled = await asUser(olga)<GrillingView>('POST', `/grillings/${g.id}/cancel`);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      currentRound: null,
      canAnswer: false,
    });
    expect(inboxChangedFor()).toEqual(new Set([olga]));
    expect((await asUser(olga)('POST', `/grillings/${g.id}/cancel`)).status).toBe(409);
    const q = g.rounds[0]?.questions[0];
    expect(
      (await asUser(olga)('POST', `/grillings/${g.id}/questions/${q?.id}/answer`, { answer: 'x' }))
        .status,
    ).toBe(409);
    expect((await asUser(olga)<InboxItem[]>('GET', '/inbox')).body).toEqual([]);

    // Drafted, then cancelled: the pending proposal is rejected and can't be approved.
    let again = (await start(wealth.id, olga)).body;
    again = await answerRound(again, olga);
    again = await answerRound(again, dana);
    again = await answerRound(again, tom);
    expect(again.status).toBe('DRAFTED');
    const afterDraft = await asUser(olga)<GrillingView>('POST', `/grillings/${again.id}/cancel`);
    expect(afterDraft.body).toMatchObject({
      status: 'CANCELLED',
      proposal: { status: 'REJECTED' },
    });
    expect(
      (await asUser(olga)('POST', `/brief-proposals/${again.proposal?.id}/approve`)).status,
    ).toBe(409);
    expect(await db.briefVersion.count()).toBe(0);
    const listed = await asUser(dana)<GrillingView[]>('GET', `/projects/${wealth.id}/grillings`);
    expect(listed.body.map((x) => x.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  test('a round with nobody holding its Team Role is skipped; with nobody at all the draft comes at once', async () => {
    await db.teamMembership.deleteMany({ where: { userId: { in: [dana, tom] } } });
    const g = await start(wealth.id, olga);
    const drafted = await answerRound(g.body, olga);
    expect(drafted.status).toBe('DRAFTED');
    expect(drafted.rounds.map((r) => r.skipReason)).toEqual([
      null,
      'NO_ONE_WITH_ROLE',
      'NO_ONE_WITH_ROLE',
    ]);

    // An Admin grilling a Project with no POs, Designers or Tech Leads at all.
    const empty = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Empty' },
    });
    const now = await start(empty.id, pim.id);
    expect(now.status).toBe(201);
    expect(now.body.status).toBe('DRAFTED');
    expect(now.body.proposal?.status).toBe('PENDING');
  });

  test('a failed AI call writes nothing: the Grilling stays where it was and the answer is 502', async () => {
    const original = ai.grillingQuestions.bind(ai);
    ai.grillingQuestions = async () => {
      throw new AiOutputError('grilling-questions', new Error('bad output'));
    };
    try {
      expect((await start(wealth.id, olga)).status).toBe(502);
      expect(await db.grilling.count()).toBe(0);
    } finally {
      ai.grillingQuestions = original;
    }

    const g = (await start(wealth.id, olga)).body;
    const [last, ...others] = current(g).questions.reverse();
    for (const q of others) {
      await asUser(olga)('POST', `/grillings/${g.id}/questions/${q.id}/answer`, { answer: 'ok' });
    }
    ai.grillingQuestions = async () => {
      throw new Error('provider unreachable');
    };
    try {
      const failed = await asUser(olga)('POST', `/grillings/${g.id}/questions/${last?.id}/answer`, {
        answer: 'the last one',
      });
      expect(failed.status).toBe(502);
    } finally {
      ai.grillingQuestions = original;
    }
    const still = await asUser(olga)<GrillingView>('GET', `/grillings/${g.id}`);
    expect(still.body.currentRound).toBe('BUSINESS');
    expect(still.body.rounds[0]?.questions.find((q) => q.id === last?.id)?.answer).toBeNull();
    expect(await db.grillingRound.count()).toBe(1);

    const originalDraft = ai.draftBriefFromGrilling.bind(ai);
    const ok = await asUser(olga)<GrillingView>(
      'POST',
      `/grillings/${g.id}/questions/${last?.id}/answer`,
      {
        answer: 'the last one',
      },
    );
    expect(ok.body.currentRound).toBe('UX');
    const afterUx = await answerRound(ok.body, dana);
    ai.draftBriefFromGrilling = async () => {
      throw new AiOutputError('draft-brief-from-grilling', new Error('bad output'));
    };
    try {
      const [q] = current(afterUx).questions;
      const rest = current(afterUx).questions.slice(1);
      for (const x of rest) {
        await asUser(tom)('POST', `/grillings/${g.id}/questions/${x.id}/answer`, { answer: 'ok' });
      }
      const failed = await asUser(tom)('POST', `/grillings/${g.id}/questions/${q?.id}/answer`, {
        answer: 'ok',
      });
      expect(failed.status).toBe(502);
      expect(await db.briefProposal.count()).toBe(0);
      const view = await asUser(tom)<GrillingView>('GET', `/grillings/${g.id}`);
      expect(view.body).toMatchObject({ status: 'RUNNING', currentRound: 'TECHNICAL' });
    } finally {
      ai.draftBriefFromGrilling = originalDraft;
    }
  });

  test('one running Grilling per Project, even when two POs start at the same time', async () => {
    const otherPo = await person('Pia');
    await join(wealth.teamId, otherPo, 'PO');
    const results = await Promise.all([start(wealth.id, olga), start(wealth.id, otherPo)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.grilling.count({ where: { projectId: wealth.id, status: 'RUNNING' } })).toBe(1);
    // The database itself refuses a second RUNNING one, whoever writes it.
    const second = await db.grilling
      .create({ data: { projectId: wealth.id, startedById: otherPo, memory: { rounds: [] } } })
      .then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(second).toBe('P2002');
    // Another Project runs its own.
    expect((await start(SEED.projectId, pim.id)).status).toBe(201);
  });

  test('answers from two people at once both count, and the round moves on once', async () => {
    const otherPo = await person('Pia');
    await join(wealth.teamId, otherPo, 'PO');
    const g = (await start(wealth.id, olga)).body;
    const qs = current(g).questions;
    const results = await Promise.all(
      qs.map((q, i) =>
        asUser(i % 2 ? otherPo : olga)('POST', `/grillings/${g.id}/questions/${q.id}/answer`, {
          answer: `answer ${i}`,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(qs.map(() => 201));
    const view = await asUser(olga)<GrillingView>('GET', `/grillings/${g.id}`);
    expect(view.body.currentRound).toBe('UX');
    expect(view.body.rounds[0]?.questions.every((q) => q.answer !== null)).toBe(true);
    expect(questionCalls().map((c) => c.round)).toEqual(['BUSINESS', 'UX']);
  });

  test('`awaiting=me` lists only Grillings of Projects where I hold the round’s Team Role', async () => {
    // Dana is a Designer in Wealth only; the seeded Project's UX round is not hers.
    const designer = await person('Dee');
    await join(SEED.teamId, designer, 'DESIGNER');
    const seeded = (await start(SEED.projectId, pim.id)).body;
    await answerRound(seeded, pim.id);
    const wealthG = (await start(wealth.id, olga)).body;
    await answerRound(wealthG, olga);
    const dees = await asUser(designer)<GrillingView[]>('GET', '/grillings?awaiting=me');
    expect(dees.body.map((g) => g.projectId)).toEqual([SEED.projectId]);
    const danas = await asUser(dana)<GrillingView[]>('GET', '/grillings?awaiting=me');
    expect(danas.body.map((g) => g.projectId)).toEqual([wealth.id]);
    expect((await asUser(dana)<InboxItem[]>('GET', '/inbox')).body).toHaveLength(1);
    expect((await asUser(tom)<GrillingView[]>('GET', '/grillings?awaiting=me')).body).toEqual([]);
  });
});
