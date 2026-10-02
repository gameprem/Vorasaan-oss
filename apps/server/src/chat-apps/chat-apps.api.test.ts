import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  ChatAppSettingsView,
  ChatAppsSettingsView,
  ChatLinkCodeView,
  ChatPreferencesView,
  MyChatAppsView,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import {
  ALL_SECRETS,
  FakeChatProviders,
  fromLine,
  fromSlack,
  fromTeams,
  LINE_CREDENTIALS,
  lineMessage,
  lineSignature,
  lineUnfollow,
  postCallback,
  SLACK_CREDENTIALS,
  slackMessage,
  TEAMS_CREDENTIALS,
  teamsMessage,
} from '../test/fake-chat-apps.ts';
import type { FakeClock } from '../test/fake-clock.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const MINUTE = 60_000;

let chatUser = 0;
/** A chat account nobody has used yet in this run. */
const newChatUser = (prefix = 'U') => `${prefix}${Date.now().toString(36)}${++chatUser}`;

describe('Chat apps: setup and linking accounts (ticket 0057)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let clock: FakeClock;
  let fake: FakeChatProviders;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  /** Every API response body and log line, to prove no credential ever shows up. */
  const seen: string[] = [];
  const record =
    (actor: ReturnType<typeof as>): ReturnType<typeof as> =>
    async (method, url, body) => {
      const res = await actor(method, url, body);
      seen.push(JSON.stringify(res.body ?? null));
      return res as never;
    };

  const turnOn = {
    line: () =>
      asPim<ChatAppSettingsView>('PUT', '/settings/chat-apps', {
        provider: 'LINE',
        ...LINE_CREDENTIALS,
      }),
    slack: () =>
      asPim<ChatAppSettingsView>('PUT', '/settings/chat-apps', {
        provider: 'SLACK',
        ...SLACK_CREDENTIALS,
      }),
    teams: () =>
      asPim<ChatAppSettingsView>('PUT', '/settings/chat-apps', {
        provider: 'TEAMS',
        ...TEAMS_CREDENTIALS,
      }),
  };

  const linkCode = async (actor: ReturnType<typeof as>, provider = 'line') => {
    const res = await actor<ChatLinkCodeView>('POST', `/me/chat-apps/${provider}/link-code`);
    expect(res.status).toBe(201);
    return res.body.code;
  };

  const lastText = () => fake.texts().at(-1) ?? '';

  beforeAll(async () => {
    fake = new FakeChatProviders().start();
    ({ app, clock } = await createTestApp());
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
    asPim = record(as(app, pim.id));
    asBeam = record(as(app, beam.id));
  });

  afterAll(async () => {
    clock.reset();
    await db.$disconnect();
    await app.close();
    fake.stop();
  });

  beforeEach(async () => {
    clock.reset();
    fake.status = 200;
    fake.hits.length = 0;
    await truncateAll(db);
    await seed(db);
  });

  describe('Settings → Chat apps (Admins)', () => {
    test('only an Admin sees or changes the chat apps', async () => {
      expect((await asBeam('GET', '/settings/chat-apps')).status).toBe(403);
      expect(
        (await asBeam('PUT', '/settings/chat-apps', { provider: 'LINE', ...LINE_CREDENTIALS }))
          .status,
      ).toBe(403);
      expect((await asBeam('DELETE', '/settings/chat-apps/line')).status).toBe(403);
    });

    test('an Admin turns LINE on; the secrets are stored encrypted and never returned', async () => {
      const before = await asPim<ChatAppsSettingsView>('GET', '/settings/chat-apps');
      expect(before.body.apps.map((a) => [a.provider, a.enabled])).toEqual([
        ['LINE', false],
        ['SLACK', false],
        ['TEAMS', false],
      ]);

      const { status, body } = await turnOn.line();
      expect(status).toBe(200);
      expect(body).toMatchObject({
        provider: 'LINE',
        enabled: true,
        secretsSet: true,
        eventsPath: '/chat-apps/line/events',
        linkedAccounts: 0,
      });
      const raw = JSON.stringify(body);
      for (const secret of Object.values(LINE_CREDENTIALS)) expect(raw).not.toContain(secret);

      const row = await db.orgIntegration.findFirstOrThrow({ where: { provider: 'LINE' } });
      expect(row.secretEncrypted.startsWith('v1:')).toBe(true);
      for (const secret of Object.values(LINE_CREDENTIALS)) {
        expect(JSON.stringify(row)).not.toContain(secret);
      }
    });

    test('the first save needs every secret; later saves keep the ones left out', async () => {
      const missing = await asPim<{ message: string }>('PUT', '/settings/chat-apps', {
        provider: 'LINE',
        channelAccessToken: LINE_CREDENTIALS.channelAccessToken,
      });
      expect(missing.status).toBe(422);
      expect(missing.body.message).toBe('Enter the channel secret');

      await turnOn.line();
      const rotated = 'line-rotated-secret-SECRET-0099';
      ALL_SECRETS.push(rotated);
      const { status } = await asPim('PUT', '/settings/chat-apps', {
        provider: 'LINE',
        channelSecret: rotated,
      });
      expect(status).toBe(200);
      // The new secret signs callbacks now; the old one no longer does.
      const body = lineMessage(newChatUser(), 'hello');
      expect((await fromLine(app, body)).status).toBe(401);
      expect(
        (
          await postCallback(app, 'line', body, {
            'x-line-signature': lineSignature(body, rotated),
          })
        ).status,
      ).toBe(200);
      // The access token was kept: the reply used it.
      expect(fake.hits.at(-1)?.authorization).toBe(`Bearer ${LINE_CREDENTIALS.channelAccessToken}`);
    });

    test('invalid input is refused without echoing the secret', async () => {
      const res = await asPim<unknown>('PUT', '/settings/chat-apps', {
        provider: 'SLACK',
        botToken: 'not-a-bot-token-SECRET-0042',
        signingSecret: SLACK_CREDENTIALS.signingSecret,
      });
      ALL_SECRETS.push('not-a-bot-token-SECRET-0042');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('A Slack bot token starts with xoxb-');
    });

    test('a new Teams app id needs its password again, and ends the links made with the old bot', async () => {
      const { body } = await turnOn.teams();
      expect(body).toMatchObject({
        provider: 'TEAMS',
        enabled: true,
        appId: TEAMS_CREDENTIALS.appId,
      });
      expect(JSON.stringify(body)).not.toContain(TEAMS_CREDENTIALS.appPassword);

      // Beam links his Teams account.
      const code = await linkCode(asBeam, 'teams');
      await fromTeams(app, fake, teamsMessage('29:beam', code, fake.serviceUrl));
      expect(await db.chatAccount.count({ where: { provider: 'TEAMS' } })).toBe(1);

      const otherApp = '11111111-2222-3333-4444-555555555555';
      const refused = await asPim<{ message: string }>('PUT', '/settings/chat-apps', {
        provider: 'TEAMS',
        appId: otherApp,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.message).toBe('Enter the bot app password again for the new app id');

      expect(
        (
          await asPim('PUT', '/settings/chat-apps', {
            provider: 'TEAMS',
            appId: otherApp,
            appPassword: TEAMS_CREDENTIALS.appPassword,
          })
        ).status,
      ).toBe(200);
      expect(await db.chatAccount.count({ where: { provider: 'TEAMS' } })).toBe(0);
    });

    test('turning a chat app off deletes its credentials, links and codes', async () => {
      await turnOn.line();
      const userId = newChatUser();
      await fromLine(app, lineMessage(userId, await linkCode(asBeam)));
      await linkCode(asPim);

      const { status, body } = await asPim<ChatAppSettingsView>(
        'DELETE',
        '/settings/chat-apps/line',
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ enabled: false, secretsSet: false, linkedAccounts: 0 });
      expect(await db.orgIntegration.count({ where: { provider: 'LINE' } })).toBe(0);
      expect(await db.chatAccount.count()).toBe(0);
      expect(await db.chatLinkCode.count()).toBe(0);
      // Its callbacks can't be verified any more.
      expect((await fromLine(app, lineMessage(userId, 'hello'))).status).toBe(401);
    });
  });

  describe('linking with a one-time code', () => {
    beforeEach(async () => {
      await turnOn.line();
    });

    test('a valid code links the account, and the bot confirms', async () => {
      const code = await linkCode(asBeam);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      const userId = newChatUser();

      // People type it as they like: lower case, no dash, "link" in front.
      const typed = `link ${code.toLowerCase().replace('-', ' ')}`;
      expect((await fromLine(app, lineMessage(userId, typed))).status).toBe(200);

      const account = await db.chatAccount.findFirstOrThrow({ where: { provider: 'LINE' } });
      expect(account).toMatchObject({ userId: beam.id, providerUserId: userId });
      expect(lastText()).toContain('Linked to Vorasaan as Beam');
      expect(fake.hits.at(-1)).toMatchObject({
        path: '/v2/bot/message/reply',
        authorization: `Bearer ${LINE_CREDENTIALS.channelAccessToken}`,
      });

      const mine = await asBeam<MyChatAppsView>('GET', '/me/chat-apps');
      expect(mine.body.apps.find((a) => a.provider === 'LINE')).toMatchObject({
        enabled: true,
        account: { provider: 'LINE' },
      });
      expect(mine.body.apps.find((a) => a.provider === 'SLACK')).toMatchObject({
        enabled: false,
        account: null,
      });
      // Pim's own view is untouched.
      const pims = await asPim<MyChatAppsView>('GET', '/me/chat-apps');
      expect(pims.body.apps.every((a) => a.account === null)).toBe(true);
    });

    test('only a hash of the code is stored', async () => {
      const code = await linkCode(asBeam);
      const row = await db.chatLinkCode.findFirstOrThrow();
      const dump = JSON.stringify(row);
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replace('-', ''));
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(10 * MINUTE);
    });

    test('a used code does not link a second account', async () => {
      const code = await linkCode(asBeam);
      await fromLine(app, lineMessage(newChatUser(), code));
      const intruder = newChatUser();
      await fromLine(app, lineMessage(intruder, code));
      expect(lastText()).toContain("That code didn't work");
      expect(await db.chatAccount.findFirst({ where: { providerUserId: intruder } })).toBeNull();
      expect(await db.chatAccount.count()).toBe(1);
    });

    test('an expired code does not link', async () => {
      const start = new Date();
      clock.set(start);
      const late = await linkCode(asBeam);
      clock.set(new Date(start.getTime() + 10 * MINUTE));
      await fromLine(app, lineMessage(newChatUser(), late));
      expect(lastText()).toContain("That code didn't work");
      expect(await db.chatAccount.count()).toBe(0);

      // Just inside the 10 minutes it still works.
      clock.set(start);
      const inTime = await linkCode(asBeam);
      clock.set(new Date(start.getTime() + 10 * MINUTE - 1000));
      await fromLine(app, lineMessage(newChatUser(), inTime));
      expect(await db.chatAccount.count()).toBe(1);
    });

    test('a wrong code does not link; after 5 wrong codes even the right one waits 15 minutes', async () => {
      const start = new Date();
      clock.set(start);
      const code = await linkCode(asBeam);
      const guesser = newChatUser();
      for (let i = 0; i < 5; i++) {
        await fromLine(app, lineMessage(guesser, `AAAAA-AAAA${i}`));
        expect(lastText()).toContain("That code didn't work");
      }
      await fromLine(app, lineMessage(guesser, code));
      expect(lastText()).toContain('Too many wrong codes');
      expect(await db.chatAccount.count()).toBe(0);

      // 15 minutes later the code itself has expired, but a new one works.
      clock.set(new Date(start.getTime() + 15 * MINUTE));
      const fresh = await linkCode(asBeam);
      await fromLine(app, lineMessage(guesser, fresh));
      expect(lastText()).toContain('Linked to Vorasaan as Beam');
    });

    test('a new code replaces the earlier one', async () => {
      const first = await linkCode(asBeam);
      const second = await linkCode(asBeam);
      await fromLine(app, lineMessage(newChatUser(), first));
      expect(await db.chatAccount.count()).toBe(0);
      await fromLine(app, lineMessage(newChatUser(), second));
      expect(await db.chatAccount.count()).toBe(1);
    });

    test('a code works only in the chat app it was made for', async () => {
      await turnOn.slack();
      const lineCode = await linkCode(asBeam, 'line');
      await fromSlack(app, slackMessage(newChatUser('W'), lineCode));
      expect(lastText()).toContain("That code didn't work");
      expect(await db.chatAccount.count()).toBe(0);
    });

    test('a chat account linked to one person cannot be linked to another', async () => {
      const shared = newChatUser();
      await fromLine(app, lineMessage(shared, await linkCode(asBeam)));
      await fromLine(app, lineMessage(shared, await linkCode(asPim)));
      expect(lastText()).toContain('already linked to another person');
      expect(await db.chatAccount.findFirst({ where: { userId: pim.id } })).toBeNull();
      expect(await db.chatAccount.findFirstOrThrow()).toMatchObject({ userId: beam.id });
    });

    test('linking another chat account replaces the person’s old one', async () => {
      const phone = newChatUser();
      const tablet = newChatUser();
      await fromLine(app, lineMessage(phone, await linkCode(asBeam)));
      await fromLine(app, lineMessage(tablet, await linkCode(asBeam)));
      const accounts = await db.chatAccount.findMany();
      expect(accounts.map((a) => a.providerUserId)).toEqual([tablet]);
    });

    test('no code without the chat app turned on', async () => {
      const res = await asBeam<{ message: string }>('POST', '/me/chat-apps/slack/link-code');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("An Admin hasn't turned on Slack");
      expect((await asBeam('POST', '/me/chat-apps/whatsapp/link-code')).status).toBe(404);
    });

    test('a redelivered event is handled once', async () => {
      const userId = newChatUser();
      const body = lineMessage(userId, 'hello', 'same-event');
      await fromLine(app, body);
      await fromLine(app, body);
      expect(fake.texts()).toHaveLength(1);
    });

    test('anything else gets a short help, depending on whether the account is linked', async () => {
      const userId = newChatUser();
      await fromLine(app, lineMessage(userId, 'hi'));
      expect(lastText()).toContain('open Settings → Notifications in Vorasaan');
      await fromLine(app, lineMessage(userId, await linkCode(asBeam)));
      await fromLine(app, lineMessage(userId, 'hi'));
      expect(lastText()).toContain("You're linked to Vorasaan as Beam");
    });

    test('a failing reply is logged with the status only, and the callback still succeeds', async () => {
      fake.status = 500;
      const res = await fromLine(app, lineMessage(newChatUser(), 'hi'));
      expect(res.status).toBe(200);
      expect(seen.some((line) => line.includes('LINE API call failed (HTTP 500)'))).toBe(true);
    });
  });

  describe('unlinking from either side', () => {
    beforeEach(async () => {
      await turnOn.line();
    });

    test('"unlink" in the chat unlinks it', async () => {
      const userId = newChatUser();
      await fromLine(app, lineMessage(userId, await linkCode(asBeam)));
      await fromLine(app, lineMessage(userId, 'Unlink'));
      expect(lastText()).toContain('Unlinked from Vorasaan');
      expect(await db.chatAccount.count()).toBe(0);
      await fromLine(app, lineMessage(userId, 'unlink'));
      expect(lastText()).toContain("isn't linked to Vorasaan");
    });

    test('blocking the LINE bot unlinks it', async () => {
      const userId = newChatUser();
      await fromLine(app, lineMessage(userId, await linkCode(asBeam)));
      await fromLine(app, lineUnfollow(userId));
      expect(await db.chatAccount.count()).toBe(0);
    });

    test('unlinking in Vorasaan tells the chat account', async () => {
      const userId = newChatUser();
      await fromLine(app, lineMessage(userId, await linkCode(asBeam)));
      fake.hits.length = 0;
      expect((await asBeam('DELETE', '/me/chat-apps/line')).status).toBe(204);
      expect(await db.chatAccount.count()).toBe(0);
      expect(fake.hits).toHaveLength(1);
      expect(fake.hits[0]?.path).toBe('/v2/bot/message/push');
      expect(JSON.parse(fake.hits[0]?.body ?? '{}')).toMatchObject({ to: userId });
      expect(lastText()).toContain('Unlinked from Vorasaan by Beam');
      expect((await asBeam('DELETE', '/me/chat-apps/line')).status).toBe(404);
    });
  });

  describe('Slack and Teams link the same way', () => {
    test('Slack', async () => {
      await turnOn.slack();
      const user = newChatUser('W');
      await fromSlack(app, slackMessage(user, await linkCode(asBeam, 'slack')));
      expect(await db.chatAccount.findFirstOrThrow()).toMatchObject({
        userId: beam.id,
        provider: 'SLACK',
        providerUserId: user,
        address: { teamId: 'T0001', channelId: `D-${user}` },
      });
      expect(fake.hits.at(-1)).toMatchObject({
        path: '/api/chat.postMessage',
        authorization: `Bearer ${SLACK_CREDENTIALS.botToken}`,
      });
      expect(lastText()).toContain('Linked to Vorasaan as Beam');
      await fromSlack(app, slackMessage(user, 'unlink'));
      expect(await db.chatAccount.count()).toBe(0);
    });

    test('Teams', async () => {
      await turnOn.teams();
      await fromTeams(
        app,
        fake,
        teamsMessage(
          '29:beam',
          `<at>Vorasaan</at> ${await linkCode(asBeam, 'teams')}`,
          fake.serviceUrl,
        ),
      );
      expect(await db.chatAccount.findFirstOrThrow()).toMatchObject({
        userId: beam.id,
        provider: 'TEAMS',
        providerUserId: '29:beam',
        displayName: 'Beam Teams',
        address: {
          serviceUrl: fake.serviceUrl,
          conversationId: 'a:conv-29:beam',
          tenantId: 'tenant-1',
        },
      });
      // The bot got a token with its app id and password, then replied in the conversation.
      const [token, reply] = fake.hits;
      expect(token?.path).toBe('/teams/token');
      expect(new URLSearchParams(token?.body).get('client_id')).toBe(TEAMS_CREDENTIALS.appId);
      expect(reply?.path).toMatch(
        /^\/connector\/v3\/conversations\/a%3Aconv-29%3Abeam\/activities\//,
      );
      expect(reply?.authorization).toBe('Bearer bot-framework-access-token');
      expect(lastText()).toContain('Linked to Vorasaan as Beam');
    });
  });

  describe('preferences (Settings → Notifications)', () => {
    test('defaults: Decision Requests and NEEDS_INFO, no quiet hours, the Organization’s time zone', async () => {
      const { body } = await asBeam<ChatPreferencesView>('GET', '/me/chat-preferences');
      expect(body).toEqual({
        events: ['DECISION_REQUEST', 'NEEDS_INFO'],
        quietHours: null,
        timeZone: null,
        effectiveTimeZone: 'UTC',
      });
    });

    test('a person chooses the events and quiet hours, for themselves only', async () => {
      const saved = await asBeam<ChatPreferencesView>('PUT', '/me/chat-preferences', {
        events: ['DECISION_REQUEST', 'SPEC_PROPOSAL'],
        quietHours: { start: '22:00', end: '07:00' },
        timeZone: 'Asia/Bangkok',
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        events: ['DECISION_REQUEST', 'SPEC_PROPOSAL'],
        quietHours: { start: '22:00', end: '07:00' },
        timeZone: 'Asia/Bangkok',
        effectiveTimeZone: 'Asia/Bangkok',
      });
      const pims = await asPim<ChatPreferencesView>('GET', '/me/chat-preferences');
      expect(pims.body.events).toEqual(['DECISION_REQUEST', 'NEEDS_INFO']);

      const bad = await asBeam('PUT', '/me/chat-preferences', {
        events: ['DECISION_REQUEST'],
        quietHours: { start: '22:00', end: '22:00' },
        timeZone: null,
      });
      expect(bad.status).toBe(400);
    });
  });

  // Runs last: every response and log line of the tests above.
  test('no credential ever appears in an API response or a log line', () => {
    expect(seen.length).toBeGreaterThan(50);
    expect(seen.some((line) => line.includes('LINE API call failed'))).toBe(true);
    const all = seen.join('\n');
    for (const secret of ALL_SECRETS) expect(all).not.toContain(secret);
  });
});
