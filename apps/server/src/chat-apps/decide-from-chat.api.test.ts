import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ChatProvider, PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  ChatPreferencesView,
  CreatedAccessToken,
  DecideResult,
  DecisionLogEntry,
  DecisionRequestView,
} from '@vorasaan/shared';
import type { EscalationJob } from '../response-windows/escalation.job.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import {
  ALL_SECRETS,
  FakeChatProviders,
  fromLine,
  fromSlackForm,
  fromTeams,
  LINE_CREDENTIALS,
  lineMessage,
  linePostback,
  SLACK_CREDENTIALS,
  slackAction,
  slackViewSubmission,
  TEAMS_CREDENTIALS,
  teamsSubmit,
} from '../test/fake-chat-apps.ts';
import type { FakeClock } from '../test/fake-clock.ts';
import { as } from '../test/http.ts';
import { ChatCardsService } from './chat-cards.service.ts';
import { ChatEventsService } from './chat-events.service.ts';

const { pim, beam } = SEED.users;

type Json = Record<string, unknown>;
type SlackPost = {
  channel: string;
  text: string;
  attachments?: { color: string; blocks: Json[] }[];
};

/** The buttons of a Slack card: label → value (or url). */
function slackButtons(post: SlackPost): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of post.attachments?.[0]?.blocks ?? []) {
    const elements = [
      ...(block.accessory ? [block.accessory as Json] : []),
      ...((block.elements as Json[] | undefined) ?? []),
    ];
    for (const e of elements) {
      if (e.type !== 'button') continue;
      out.set((e.text as Json).text as string, (e.value ?? e.url) as string);
    }
  }
  return out;
}

/** The postback buttons of a LINE Flex card: label → data (or uri). */
function lineButtons(message: Json): Map<string, string> {
  const footer = ((message.contents as Json).footer as Json).contents as Json[];
  return new Map(
    footer.map((b) => {
      const action = b.action as Json;
      return [action.label as string, (action.data ?? action.uri) as string];
    }),
  );
}

/** The submit buttons of a Teams Adaptive Card: title → token. */
function teamsButtons(activity: Json): Map<string, string> {
  const card = ((activity.attachments as Json[])[0] as Json).content as Json;
  const out = new Map<string, string>();
  const visit = (actions: Json[]) => {
    for (const a of actions) {
      if (a.type === 'Action.Submit')
        out.set(a.title as string, (a.data as Json).vorasaan as string);
      if (a.type === 'Action.ShowCard') {
        const inner = a.card as Json;
        out.set(
          a.title as string,
          (((inner.actions as Json[])[0] as Json).data as Json).vorasaan as string,
        );
      }
      if (a.type === 'Action.OpenUrl') out.set(a.title as string, a.url as string);
    }
  };
  for (const item of card.body as Json[]) {
    for (const inner of (item.items as Json[] | undefined) ?? []) {
      if (inner.type === 'ActionSet') visit(inner.actions as Json[]);
    }
  }
  visit(card.actions as Json[]);
  return out;
}

describe('Deciding from LINE, Slack and Teams (ticket 0058)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let clock: FakeClock;
  let escalation: EscalationJob;
  let fake: FakeChatProviders;
  let cards: ChatCardsService;
  let events: ChatEventsService;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  const seen: string[] = [];
  /** Everything sent to the fake providers across the tests (but the Teams token call). */
  const sentBodies: string[] = [];

  const settle = async () => {
    await events.drain();
    await cards.drain();
  };

  async function person(name: string, poOwner = true) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: user.id, role: 'MEMBER' },
    });
    await db.teamMembership.create({ data: { teamId: SEED.teamId, userId: user.id, role: 'PO' } });
    if (poOwner) {
      await db.roleOwner.create({
        data: { featureId: SEED.featureId, userId: user.id, role: 'PO' },
      });
    }
    return { id: user.id, name, call: as(app, user.id) };
  }

  async function link(userId: string, provider: ChatProvider, providerUserId: string) {
    const address =
      provider === 'SLACK'
        ? { teamId: 'T0001', channelId: `D-${providerUserId}` }
        : provider === 'TEAMS'
          ? {
              serviceUrl: fake.serviceUrl,
              conversationId: `a:conv-${providerUserId}`,
              tenantId: 'tenant-1',
              botId: `28:${TEAMS_CREDENTIALS.appId}`,
            }
          : {};
    await db.chatAccount.create({
      data: {
        organizationId: SEED.organizationId,
        userId,
        provider,
        providerUserId,
        address,
        createdAt: new Date(),
      },
    });
  }

  /** Beam raises a Blocker and sends it to the PO Role Owners (or one of them). */
  async function sendBlocker(recipients: 'ALL' | { userId: string } = 'ALL') {
    const draft = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'SECRET-DESCRIPTION: only polling is available.',
    });
    const sent = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.body.id}/submit`,
      { deciderRole: 'PO', recipients },
    );
    expect(sent.status).toBe(201);
    await settle();
    return sent.body;
  }

  const request = (id: string) =>
    db.decisionRequest.findUniqueOrThrow({
      where: { id },
      include: { decision: { include: { choice: true } }, messages: true },
    });

  const slackPosts = () =>
    fake.sentTo<SlackPost>('/api/chat.postMessage').filter((p) => p.attachments);
  /** The last reply to a person: not a card, nor a card replaced after a press. */
  const lastText = () =>
    fake
      .texts(
        (h) =>
          h.path !== '/api/chat.update' && h.method !== 'PUT' && !h.body.includes('"attachments"'),
      )
      .at(-1) ?? '';

  beforeAll(async () => {
    fake = new FakeChatProviders().start();
    ({ app, clock, escalation } = await createTestApp());
    const logger: LoggerService = {
      log: (m) => seen.push(String(m)),
      error: (m, ...rest) => seen.push(String(m), ...rest.map(String)),
      warn: (m) => seen.push(String(m)),
      debug: (m) => seen.push(String(m)),
      verbose: (m) => seen.push(String(m)),
    };
    app.useLogger(logger);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        seen.push(args.map(String).join(' '));
      });
    }
    db = createTestPrisma();
    cards = app.get(ChatCardsService);
    events = app.get(ChatEventsService);
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    clock.reset();
    await db.$disconnect();
    await app.close();
    fake.stop();
  });

  beforeEach(async () => {
    sentBodies.push(...fake.hits.filter((h) => h.path !== '/teams/token').map((h) => h.body));
    clock.reset();
    fake.status = 200;
    fake.statusFor.clear();
    await truncateAll(db);
    await seed(db);
    fake.hits.length = 0;
    for (const body of [
      { provider: 'LINE', ...LINE_CREDENTIALS },
      { provider: 'SLACK', ...SLACK_CREDENTIALS },
      { provider: 'TEAMS', ...TEAMS_CREDENTIALS },
    ]) {
      expect((await asPim('PUT', '/settings/chat-apps', body)).status).toBe(200);
    }
    fake.hits.length = 0;
  });

  // ─── Slack ────────────────────────────────────────────────────────────────

  describe('Slack', () => {
    test('a sent request arrives as a Block Kit card: title, Blocker red, Choices with impact, buttons, a link; never the description', async () => {
      // A Wednesday morning, so the Blocker's 4 working hours end the same day.
      clock.set('2026-09-30T09:00:00Z');
      await link(pim.id, 'SLACK', 'UPIM');
      const sent = await sendBlocker();

      const [post] = slackPosts();
      expect(post?.channel).toBe('D-UPIM');
      expect(post?.text).toContain('Provider has no webhook');
      expect(post?.attachments?.[0]?.color).toBe('#B8321F');
      const json = JSON.stringify(post);
      expect(json).toContain('Blocker');
      expect(json).toContain('Scope B');
      expect(json).toContain('+2 days');
      expect(json).toContain('Risk C');
      expect(json).toContain('From Beam');
      expect(json).toMatch(/Due .*\(in \dh\)/);
      expect(json).not.toContain('SECRET-DESCRIPTION');
      const buttons = slackButtons(post as SlackPost);
      expect([...buttons.keys()]).toEqual([
        'Choose A',
        'Choose B',
        'Choose C',
        'Ask for more info',
        'Write your own answer',
        'Open in Vorasaan',
      ]);
      expect(buttons.get('Open in Vorasaan')).toBe(`http://localhost:3000/requests/${sent.id}`);
      // The button payload names a card, not a person.
      expect(buttons.get('Choose B')).not.toContain(pim.id);

      const card = await db.chatCard.findFirstOrThrow({ where: { userId: pim.id } });
      expect(card).toMatchObject({ provider: 'SLACK', event: 'DECISION_REQUEST', status: 'SENT' });
      expect(card.messageRef).toEqual({ channel: 'D-UPIM', ts: expect.any(String) });
    });

    test('pressing Choice B decides as that person, and the Decision Log records Slack', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      const sent = await sendBlocker();
      const token = slackButtons(slackPosts()[0] as SlackPost).get('Choose B') as string;
      fake.hits.length = 0;

      const res = await fromSlackForm(app, slackAction('UPIM', token));
      expect(res.status).toBe(200);
      await settle();

      const after = await request(sent.id);
      expect(after.status).toBe('DECIDED');
      expect(after.decision).toMatchObject({ decidedById: pim.id, source: 'SLACK' });
      expect(after.decision?.choice?.label).toBe('B');

      const log = await asPim<DecisionLogEntry[]>(
        'GET',
        `/features/${SEED.featureId}/decision-log`,
      );
      expect(log.body.map((e) => [e.requestTitle, e.source])).toEqual([
        ['Provider has no webhook', 'SLACK'],
      ]);
      const view = await asPim<DecisionRequestView>('GET', `/decision-requests/${sent.id}`);
      expect(view.body.decision?.source).toBe('SLACK');

      // The reply goes to the person's own DM with the Spec Proposal link, and the card
      // loses its buttons.
      const reply = fake.sentTo<SlackPost>('/api/chat.postMessage').at(-1);
      expect(reply?.channel).toBe('UPIM');
      expect(reply?.text).toContain('Decided: Choice B: Option B');
      expect(reply?.text).toMatch(
        /Spec Proposal is ready to review: http:\/\/localhost:3000\/features\/.+\/proposals\/.+/,
      );
      const [update] = fake.sentTo<SlackPost & { ts: string }>('/api/chat.update');
      expect(update?.channel).toBe('D-UPIM');
      expect(JSON.stringify(update)).toContain('Decided: Choice B');
      expect(slackButtons(update as SlackPost).has('Choose A')).toBe(false);
    });

    test('a press from an account linked to someone else, or from no link, is refused and changes nothing', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      await link(beam.id, 'SLACK', 'UBEAM');
      const sent = await sendBlocker();
      const token = slackButtons(slackPosts()[0] as SlackPost).get('Choose B') as string;
      fake.hits.length = 0;

      expect((await fromSlackForm(app, slackAction('UBEAM', token))).status).toBe(200);
      await settle();
      expect(lastText()).toContain('sent to someone else');

      expect((await fromSlackForm(app, slackAction('UNOBODY', token))).status).toBe(200);
      await settle();
      expect(lastText()).toContain("isn't linked to Vorasaan");

      const after = await request(sent.id);
      expect(after.status).toBe('OPEN');
      expect(after.decision).toBeNull();
      expect(fake.sentTo('/api/chat.update')).toEqual([]);
    });

    test('a press on a request already decided answers "already decided by …" and changes nothing', async () => {
      const nok = await person('Nok');
      await link(pim.id, 'SLACK', 'UPIM');
      const sent = await sendBlocker();
      const choiceA = sent.choices.find((c) => c.label === 'A');
      const decided = await nok.call<DecideResult>(
        'POST',
        `/decision-requests/${sent.id}/decision`,
        {
          choiceId: choiceA?.id,
        },
      );
      expect(decided.status).toBe(201);
      await settle();
      const token = slackButtons(slackPosts()[0] as SlackPost).get('Choose B') as string;
      fake.hits.length = 0;

      await fromSlackForm(app, slackAction('UPIM', token));
      await settle();
      expect(lastText()).toBe(`Already decided by Nok: Choice A: ${choiceA?.title}.`);
      const after = await request(sent.id);
      expect(after.decision).toMatchObject({ decidedById: nok.id, source: 'WEB' });
      expect(after.decision?.choice?.label).toBe('A');
      // The card says so too, without buttons.
      const [update] = fake.sentTo<SlackPost>('/api/chat.update');
      expect(JSON.stringify(update)).toContain('Already decided by Nok');
    });

    test('Claimed by someone else, withdrawn: the reply says so and nothing changes', async () => {
      const nok = await person('Nok');
      await link(pim.id, 'SLACK', 'UPIM');
      const sent = await sendBlocker();
      const token = slackButtons(slackPosts()[0] as SlackPost).get('Choose B') as string;
      expect((await nok.call('POST', `/decision-requests/${sent.id}/claim`)).status).toBe(201);

      await fromSlackForm(app, slackAction('UPIM', token));
      await settle();
      expect(lastText()).toContain('Nok has Claimed this');
      expect((await request(sent.id)).deciderId).toBe(nok.id);

      await asBeam('POST', `/decision-requests/${sent.id}/withdraw`);
      await fromSlackForm(app, slackAction('UPIM', token));
      await settle();
      expect(lastText()).toBe('Withdrawn by Beam. Nothing to decide.');
      expect((await request(sent.id)).decision).toBeNull();
    });

    test('a forged or edited button payload is refused; a replayed press does nothing twice', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      const sent = await sendBlocker();
      const buttons = slackButtons(slackPosts()[0] as SlackPost);
      const tokenB = buttons.get('Choose B') as string;
      const choiceA = sent.choices.find((c) => c.label === 'A')?.id as string;
      const choiceB = sent.choices.find((c) => c.label === 'B')?.id as string;

      // The Choice swapped inside a signed payload, a made-up card, plain garbage.
      for (const forged of [
        tokenB.replace(choiceB, choiceA),
        tokenB.replace(/^v1\.[0-9a-f-]{36}/, 'v1.00000000-0000-4000-8000-000000000999'),
        'v1.not-a-token',
      ]) {
        await fromSlackForm(app, slackAction('UPIM', forged));
        await settle();
        expect(lastText()).toContain('That button didn’t work');
      }
      expect((await request(sent.id)).status).toBe('OPEN');

      // The same press delivered twice (same trigger id) is handled once.
      const press = slackAction('UPIM', tokenB, { triggerId: 'trigger-same' });
      await fromSlackForm(app, press);
      await fromSlackForm(app, press);
      await settle();
      expect(await db.decision.count()).toBe(1);
      const replies = fake.texts().filter((t) => t.startsWith('Decided'));
      expect(replies).toHaveLength(1);

      // A second, later press of the same button: already decided, by you.
      await fromSlackForm(app, slackAction('UPIM', tokenB));
      await settle();
      expect(lastText()).toBe(
        'You already decided this: Choice B: Option B for "Provider has no webhook".',
      );
      expect(await db.decision.count()).toBe(1);
    });

    test('Ask for more info opens a modal; its question moves the request to NEEDS_INFO and the Raiser gets a card', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      await link(beam.id, 'SLACK', 'UBEAM');
      const sent = await sendBlocker();
      const ask = slackButtons(slackPosts()[0] as SlackPost).get('Ask for more info') as string;
      fake.hits.length = 0;

      await fromSlackForm(app, slackAction('UPIM', ask, { triggerId: 'trig-ask' }));
      await settle();
      const [modal] = fake.sentTo<{ trigger_id: string; view: Json }>('/api/views.open');
      expect(modal?.trigger_id).toBe('trig-ask');
      expect(modal?.view.private_metadata).toBe(ask);
      expect((await request(sent.id)).status).toBe('OPEN');

      const res = await fromSlackForm(
        app,
        slackViewSubmission('UPIM', modal?.view.private_metadata as string, 'Which provider?'),
      );
      expect(res).toEqual({ status: 200, body: '' });
      await settle();
      const after = await request(sent.id);
      expect(after.status).toBe('NEEDS_INFO');
      expect(after.deciderId).toBe(pim.id);
      expect(after.messages.map((m) => [m.kind, m.authorId, m.body])).toEqual([
        ['QUESTION', pim.id, 'Which provider?'],
      ]);
      expect(fake.texts()).toContain(
        'Your question went to Beam. The request waits for their answer.',
      );

      // The Raiser's card: the question and a link, no buttons to decide.
      const raiserCard = slackPosts().find((p) => p.channel === 'D-UBEAM');
      expect(JSON.stringify(raiserCard)).toContain('Pim asks: Which provider?');
      expect([...slackButtons(raiserCard as SlackPost).keys()]).toEqual(['Answer in Vorasaan']);

      // The answer brings the request back to the Decider's chat with it.
      fake.hits.length = 0;
      await asBeam('POST', `/decision-requests/${sent.id}/messages`, {
        kind: 'ANSWER',
        body: 'Omise.',
      });
      await settle();
      const back = slackPosts().find((p) => p.channel === 'D-UPIM');
      expect(JSON.stringify(back)).toContain('Beam answered: Omise.');
      expect(slackButtons(back as SlackPost).has('Choose B')).toBe(true);
    });

    test('Write your own answer: the modal’s text decides with it', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      const sent = await sendBlocker();
      const own = slackButtons(slackPosts()[0] as SlackPost).get('Write your own answer') as string;
      await fromSlackForm(app, slackViewSubmission('UPIM', own, 'Poll every 30 seconds.'));
      await settle();
      const after = await request(sent.id);
      expect(after.decision).toMatchObject({
        customAnswer: 'Poll every 30 seconds.',
        choiceId: null,
        source: 'SLACK',
      });
      expect(fake.texts().some((t) => t.startsWith('Decided with your own answer.'))).toBe(true);
    });
  });

  // ─── LINE ─────────────────────────────────────────────────────────────────

  describe('LINE', () => {
    test('a Flex Message card; pressing Choice B decides as that person with source LINE', async () => {
      await link(pim.id, 'LINE', 'Upimline');
      const sent = await sendBlocker();
      const [push] = fake.sentTo<{ to: string; messages: Json[] }>('/v2/bot/message/push');
      expect(push?.to).toBe('Upimline');
      const flex = push?.messages[0] as Json;
      expect(flex.type).toBe('flex');
      expect(flex.altText).toContain('Provider has no webhook');
      expect(((flex.contents as Json).header as Json).backgroundColor).toBe('#B8321F');
      expect(JSON.stringify(flex)).not.toContain('SECRET-DESCRIPTION');
      const buttons = lineButtons(flex);
      expect([...buttons.keys()]).toEqual([
        'Choose A',
        'Choose B',
        'Choose C',
        'Ask for more info',
        'Own answer',
        'Open in Vorasaan',
      ]);
      for (const data of buttons.values()) expect(data.length).toBeLessThanOrEqual(300);

      await fromLine(app, linePostback('Upimline', buttons.get('Choose B') as string));
      await settle();
      const after = await request(sent.id);
      expect(after.decision).toMatchObject({ decidedById: pim.id, source: 'LINE' });
      expect(after.decision?.choice?.label).toBe('B');
      const [reply] = fake.sentTo<{ replyToken: string; messages: Json[] }>(
        '/v2/bot/message/reply',
      );
      expect(String(reply?.messages[0]?.text)).toContain('Decided: Choice B');
    });

    test('a press from someone else’s LINE account or an unlinked one is refused; an already decided request says so', async () => {
      const nok = await person('Nok');
      await link(pim.id, 'LINE', 'Upimline');
      await link(nok.id, 'LINE', 'Unokline');
      const sent = await sendBlocker();
      const pimCard = fake
        .sentTo<{ to: string; messages: Json[] }>('/v2/bot/message/push')
        .find((p) => p.to === 'Upimline');
      const token = lineButtons(pimCard?.messages[0] as Json).get('Choose B') as string;

      await fromLine(app, linePostback('Unokline', token));
      await settle();
      expect(lastText()).toContain('sent to someone else');
      await fromLine(app, linePostback('Ustranger', token));
      await settle();
      expect(lastText()).toContain("isn't linked to Vorasaan");
      expect((await request(sent.id)).decision).toBeNull();

      const choiceC = sent.choices.find((c) => c.label === 'C');
      await nok.call('POST', `/decision-requests/${sent.id}/decision`, { choiceId: choiceC?.id });
      await fromLine(app, linePostback('Upimline', token));
      await settle();
      expect(lastText()).toBe(`Already decided by Nok: Choice C: ${choiceC?.title}.`);
      expect((await request(sent.id)).decision?.decidedById).toBe(nok.id);
    });

    test('Ask for more info: the next message is the question; "cancel" stops it', async () => {
      await link(pim.id, 'LINE', 'Upimline');
      const sent = await sendBlocker();
      const [push] = fake.sentTo<{ messages: Json[] }>('/v2/bot/message/push');
      const buttons = lineButtons(push?.messages[0] as Json);

      await fromLine(app, linePostback('Upimline', buttons.get('Ask for more info') as string));
      await settle();
      expect(lastText()).toContain('Send your question for Beam as your next message');
      await fromLine(app, lineMessage('Upimline', 'cancel'));
      await settle();
      expect(lastText()).toBe('Cancelled. Nothing was sent.');
      expect((await request(sent.id)).status).toBe('OPEN');

      await fromLine(app, linePostback('Upimline', buttons.get('Ask for more info') as string));
      await settle();
      await fromLine(app, lineMessage('Upimline', 'Which provider?'));
      await settle();
      const after = await request(sent.id);
      expect(after.status).toBe('NEEDS_INFO');
      expect(after.messages.map((m) => m.body)).toEqual(['Which provider?']);

      // Without a prompt, a message is just a message again.
      await fromLine(app, lineMessage('Upimline', 'hello'));
      await settle();
      expect(lastText()).toBe('You\'re linked to Vorasaan as Pim. Send "unlink" to disconnect.');
    });

    test('a reply token that expired while the Decision drafted falls back to a push', async () => {
      await link(pim.id, 'LINE', 'Upimline');
      const sent = await sendBlocker();
      const [push] = fake.sentTo<{ messages: Json[] }>('/v2/bot/message/push');
      const token = lineButtons(push?.messages[0] as Json).get('Choose A') as string;
      fake.statusFor.set('/v2/bot/message/reply', 400);
      fake.hits.length = 0;
      await fromLine(app, linePostback('Upimline', token));
      await settle();
      expect((await request(sent.id)).status).toBe('DECIDED');
      const pushes = fake.sentTo<{ to: string; messages: Json[] }>('/v2/bot/message/push');
      expect(pushes.at(-1)?.to).toBe('Upimline');
      expect(String(pushes.at(-1)?.messages[0]?.text)).toContain('Decided: Choice A');
    });
  });

  // ─── Teams ────────────────────────────────────────────────────────────────

  describe('Microsoft Teams', () => {
    const teamsCards = () =>
      fake
        .sentTo<Json>((p) => p.startsWith('/connector/'))
        .filter((a) => Array.isArray(a.attachments));

    test('an Adaptive Card; Action.Submit on Choice B decides with source Teams and the card is updated', async () => {
      await link(pim.id, 'TEAMS', '29:pim');
      const sent = await sendBlocker();
      const [activity] = teamsCards();
      const content = (((activity as Json).attachments as Json[])[0] as Json).content as Json;
      expect(content.type).toBe('AdaptiveCard');
      expect(JSON.stringify(content)).toContain('"style":"attention"');
      expect(JSON.stringify(content)).not.toContain('SECRET-DESCRIPTION');
      const buttons = teamsButtons(activity as Json);
      expect([...buttons.keys()]).toEqual([
        'Choose A',
        'Choose B',
        'Choose C',
        'Ask for more info',
        'Write your own answer',
        'Open in Vorasaan',
      ]);
      const card = await db.chatCard.findFirstOrThrow({ where: { userId: pim.id } });
      const ref = card.messageRef as { activityId: string };
      fake.hits.length = 0;

      const res = await fromTeams(
        app,
        fake,
        teamsSubmit(
          '29:pim',
          { vorasaan: buttons.get('Choose B') },
          fake.serviceUrl,
          ref.activityId,
        ),
      );
      expect(res.status).toBe(200);
      await settle();
      const after = await request(sent.id);
      expect(after.decision).toMatchObject({ decidedById: pim.id, source: 'TEAMS' });
      expect(after.decision?.choice?.label).toBe('B');
      expect(fake.texts().some((t) => t.startsWith('Decided: Choice B'))).toBe(true);
      const update = fake.hits.find((h) => h.method === 'PUT');
      expect(update?.path).toContain(`/activities/${ref.activityId}`);
      expect(update?.body).toContain('Decided: Choice B');
    });

    test('someone else’s or an unlinked Teams account is refused; the own-answer input decides', async () => {
      const nok = await person('Nok');
      await link(pim.id, 'TEAMS', '29:pim');
      await link(nok.id, 'TEAMS', '29:nok');
      const sent = await sendBlocker();
      // Pim's card: the one sent to her conversation.
      const [pimCard] = fake.hits.filter((h) =>
        h.path.includes(encodeURIComponent('a:conv-29:pim')),
      );
      const buttons = teamsButtons(JSON.parse(pimCard?.body as string) as Json);
      expect(teamsCards()).toHaveLength(2);

      await fromTeams(
        app,
        fake,
        teamsSubmit('29:nok', { vorasaan: buttons.get('Choose B') }, fake.serviceUrl),
      );
      await fromTeams(
        app,
        fake,
        teamsSubmit('29:who', { vorasaan: buttons.get('Choose B') }, fake.serviceUrl),
      );
      await settle();
      expect(fake.texts()).toContain(
        'This card was sent to someone else, so its buttons don’t work for you.',
      );
      expect(fake.texts()).toContain("This Microsoft Teams account isn't linked to Vorasaan.");
      expect((await request(sent.id)).decision).toBeNull();

      await fromTeams(
        app,
        fake,
        teamsSubmit(
          '29:pim',
          { vorasaan: buttons.get('Write your own answer'), text: 'Use the polling API.' },
          fake.serviceUrl,
        ),
      );
      await settle();
      expect((await request(sent.id)).decision).toMatchObject({
        decidedById: pim.id,
        customAnswer: 'Use the polling API.',
        source: 'TEAMS',
      });
    });
  });

  // ─── Delivery: preferences, Quiet Hours, other cards ──────────────────────

  describe('delivery', () => {
    test('nothing goes to a person who switched Decision Requests off, or has no linked account', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      await asPim('PUT', '/me/chat-preferences', {
        events: ['NEEDS_INFO'],
        quietHours: null,
        timeZone: null,
      });
      await sendBlocker();
      expect(slackPosts()).toEqual([]);
      expect(await db.chatCard.count()).toBe(0);
    });

    test('Quiet Hours hold a card back; it goes out when they end, unless it no longer matters', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      await asPim('PUT', '/me/chat-preferences', {
        events: ['DECISION_REQUEST', 'NEEDS_INFO'],
        quietHours: { start: '22:00', end: '07:00' },
        timeZone: 'UTC',
      });
      clock.set('2026-09-30T23:00:00Z');
      const first = await sendBlocker({ userId: pim.id });
      const second = await sendBlocker({ userId: pim.id });
      expect(slackPosts()).toEqual([]);
      expect((await db.chatCard.findMany()).map((c) => c.status)).toEqual(['PENDING', 'PENDING']);

      clock.set('2026-10-01T03:00:00Z');
      expect(await cards.flush()).toEqual({ sent: 0, skipped: 0, waiting: 2 });

      // Decided on the web before the night ended: its card is no longer sent.
      await asPim('POST', `/decision-requests/${second.id}/decision`, {
        choiceId: second.choices[0]?.id,
      });
      clock.set('2026-10-01T07:01:00Z');
      expect(await cards.flush()).toEqual({ sent: 1, skipped: 1, waiting: 0 });
      const posts = slackPosts();
      expect(posts).toHaveLength(1);
      expect(slackButtons(posts[0] as SlackPost).get('Open in Vorasaan')).toContain(first.id);
      expect(await cards.flush()).toEqual({ sent: 0, skipped: 0, waiting: 0 });
    });

    test('escalation: a reminder to the Decider, and the overdue notice to the Raiser, each when chosen', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      await link(beam.id, 'SLACK', 'UBEAM');
      for (const call of [asPim, asBeam]) {
        await call('PUT', '/me/chat-preferences', {
          events: ['DECISION_REQUEST', 'NEEDS_INFO', 'ESCALATION'],
          quietHours: null,
          timeZone: null,
        });
      }
      clock.set('2026-09-30T09:00:00Z'); // a Wednesday: the default calendar, UTC 09-18
      const sent = await sendBlocker({ userId: pim.id });
      fake.hits.length = 0;

      clock.set('2026-09-30T13:01:00Z'); // the 4 working hours are up
      await escalation.run();
      await settle();
      const reminder = slackPosts().find((p) => p.channel === 'D-UPIM');
      expect(JSON.stringify(reminder)).toContain('Reminder: waiting for your decision');
      expect(JSON.stringify(reminder)).toContain('overdue');
      expect(slackButtons(reminder as SlackPost).has('Choose A')).toBe(true);

      clock.set('2026-10-01T09:30:00Z'); // a whole window later: overdue reported
      await escalation.run();
      await settle();
      const overdue = slackPosts().find((p) => p.channel === 'D-UBEAM');
      expect(JSON.stringify(overdue)).toContain('Still waiting on Pim.');
      expect([...slackButtons(overdue as SlackPost).keys()]).toEqual(['Open in Vorasaan']);
      expect(overdue?.text).toContain(sent.title);
    });

    test('a Spec Proposal is only a "Review in Vorasaan" link, when chosen', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      await asPim('PUT', '/me/chat-preferences', {
        events: ['DECISION_REQUEST', 'SPEC_PROPOSAL'],
        quietHours: null,
        timeZone: null,
      });
      const sent = await sendBlocker({ userId: pim.id });
      const token = slackButtons(slackPosts()[0] as SlackPost).get('Choose A') as string;
      fake.hits.length = 0;
      await fromSlackForm(app, slackAction('UPIM', token));
      await settle();
      const proposalCard = slackPosts().find((p) =>
        JSON.stringify(p).includes('Spec Proposal to review'),
      );
      const buttons = slackButtons(proposalCard as SlackPost);
      expect([...buttons.keys()]).toEqual(['Review in Vorasaan']);
      const proposal = await db.specProposal.findFirstOrThrow({
        where: { decision: { requestId: sent.id } },
      });
      expect(buttons.get('Review in Vorasaan')).toBe(
        `http://localhost:3000/features/${SEED.featureId}/proposals/${proposal.id}`,
      );
      expect(JSON.stringify(proposalCard)).not.toContain('## Decisions');
    });

    test('cards and replies follow the person’s language: Thai', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      const saved = await asPim<{ language: string }>('PUT', '/me/chat-preferences', {
        events: ['DECISION_REQUEST', 'NEEDS_INFO'],
        quietHours: null,
        timeZone: null,
        language: 'th',
      });
      expect(saved.body.language).toBe('th');
      const sent = await sendBlocker();
      const buttons = slackButtons(slackPosts()[0] as SlackPost);
      expect([...buttons.keys()]).toEqual([
        'เลือก A',
        'เลือก B',
        'เลือก C',
        'ขอข้อมูลเพิ่ม',
        'ตอบด้วยคำของตัวเอง',
        'เปิดใน Vorasaan',
      ]);
      expect(JSON.stringify(slackPosts()[0])).toContain('ขอบเขต: Scope A');
      await fromSlackForm(app, slackAction('UPIM', buttons.get('เลือก B') as string));
      await settle();
      expect((await request(sent.id)).status).toBe('DECIDED');
      expect(fake.texts().some((t) => t.startsWith('ตัดสินใจแล้ว: Choice B'))).toBe(true);
    });

    test('without a language of their own, a person gets the Organization’s (ticket 0063)', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      expect((await asPim('PUT', '/settings/organization', { language: 'th' })).status).toBe(200);
      const prefs = await asPim<ChatPreferencesView>('GET', '/me/chat-preferences');
      expect(prefs.body).toMatchObject({ language: null, effectiveLanguage: 'th' });
      await sendBlocker();
      const buttons = slackButtons(slackPosts()[0] as SlackPost);
      expect([...buttons.keys()][0]).toBe('เลือก A');

      // Their own choice wins over the Organization's.
      await asPim('PUT', '/me/chat-preferences', {
        events: ['DECISION_REQUEST', 'NEEDS_INFO'],
        quietHours: null,
        timeZone: null,
        language: 'en',
      });
      await sendBlocker();
      expect([...slackButtons(slackPosts().at(-1) as SlackPost).keys()][0]).toBe('Choose A');
    });

    test('a failing chat app never fails or holds up the web action; the card is FAILED and nothing secret is logged', async () => {
      await link(pim.id, 'SLACK', 'UPIM');
      await link(pim.id, 'LINE', 'Upimline');
      fake.status = 500;
      const sent = await sendBlocker();
      expect(sent.status).toBe('OPEN');
      expect((await db.chatCard.findMany()).map((c) => c.status).sort()).toEqual([
        'FAILED',
        'FAILED',
      ]);
      expect(seen.some((line) => line.includes('SLACK API call failed (HTTP 500)'))).toBe(true);
    });

    test('the CLI’s Decisions are recorded as from the CLI', async () => {
      const sent = await sendBlocker({ userId: pim.id });
      const pat = await asPim<CreatedAccessToken>('POST', '/me/tokens', { name: 'laptop' });
      const res = await app.inject({
        method: 'POST',
        url: `/decision-requests/${sent.id}/decision`,
        headers: { authorization: `Bearer ${pat.body.token}` },
        payload: { choiceId: sent.choices[0]?.id },
      });
      expect(res.statusCode).toBe(201);
      expect((await request(sent.id)).decision?.source).toBe('CLI');
    });
  });

  // Runs last: every log line of the tests above.
  test('no credential or signing key ever appears in a log line or a card', () => {
    // Only the Teams token request may carry the bot's password: to Microsoft's token URL.
    const everything = [...seen, ...sentBodies].join('\n');
    for (const secret of [...ALL_SECRETS, process.env.VORASAAN_SECRET_KEY as string]) {
      expect(everything).not.toContain(secret);
    }
  });
});
