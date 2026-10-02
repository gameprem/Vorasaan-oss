import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import {
  FakeChatProviders,
  fromLine,
  fromSlack,
  fromTeams,
  LINE_CREDENTIALS,
  lineMessage,
  lineSignature,
  postCallback,
  SLACK_CREDENTIALS,
  slackMessage,
  slackSignature,
  TEAMS_CREDENTIALS,
  TEAMS_KID,
  teamsMessage,
} from '../test/fake-chat-apps.ts';
import { as } from '../test/http.ts';

const { pim } = SEED.users;

/**
 * `POST /chat-apps/:provider/events` checks each provider's signature before reading
 * the body (ticket 0057). A bad or missing one gets 401, the body is never acted on, and
 * nothing is logged.
 */
describe('chat app callbacks are verified before anything is read', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let fake: FakeChatProviders;
  const logs: string[] = [];

  /** 401 with Nest's bare body, no reply sent to anyone, nothing logged. */
  async function expectRejected(res: { status: number; body: string }) {
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ message: 'Unauthorized', statusCode: 401 });
    expect(fake.hits).toHaveLength(0);
    expect(logs).toEqual([]);
  }

  beforeAll(async () => {
    fake = new FakeChatProviders().start();
    ({ app } = await createTestApp());
    const capture: LoggerService = {
      log: (m) => logs.push(String(m)),
      error: (m) => logs.push(String(m)),
      warn: (m) => logs.push(String(m)),
      debug: (m) => logs.push(String(m)),
      verbose: (m) => logs.push(String(m)),
    };
    app.useLogger(capture);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
    fake.stop();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    const admin = as(app, pim.id);
    for (const input of [
      { provider: 'LINE', ...LINE_CREDENTIALS },
      { provider: 'SLACK', ...SLACK_CREDENTIALS },
      { provider: 'TEAMS', ...TEAMS_CREDENTIALS },
    ]) {
      expect((await admin('PUT', '/settings/chat-apps', input)).status).toBe(200);
    }
    fake.hits.length = 0;
    logs.length = 0;
  });

  test('an unknown chat app is 404; one an Admin has not turned on is 401', async () => {
    expect((await postCallback(app, 'whatsapp' as never, '{}', {})).status).toBe(404);
    await as(app, pim.id)('DELETE', '/settings/chat-apps/line');
    fake.hits.length = 0;
    const body = lineMessage('U1', 'hello');
    await expectRejected(await fromLine(app, body));
  });

  describe('LINE: x-line-signature, HMAC-SHA256 of the raw body with the channel secret', () => {
    test('a valid signature is accepted', async () => {
      expect((await fromLine(app, lineMessage('U1', 'hello'))).status).toBe(200);
      expect(fake.texts()).toHaveLength(1);
    });

    test('a missing signature is rejected', async () => {
      await expectRejected(await postCallback(app, 'line', lineMessage('U1', 'hello'), {}));
    });

    test('a signature with another secret is rejected', async () => {
      const body = lineMessage('U1', 'hello');
      await expectRejected(
        await postCallback(app, 'line', body, {
          'x-line-signature': lineSignature(body, 'not-the-channel-secret'),
        }),
      );
    });

    test('a body changed after signing is rejected', async () => {
      const signed = lineMessage('U1', 'hello');
      const tampered = signed.replace('hello', 'unlink');
      await expectRejected(
        await postCallback(app, 'line', tampered, { 'x-line-signature': lineSignature(signed) }),
      );
    });

    test('a body that is not even JSON is rejected for its signature, not parsed', async () => {
      await expectRejected(
        await postCallback(app, 'line', '{"events": [', { 'x-line-signature': 'AAAA' }),
      );
      await expectRejected(
        await postCallback(app, 'line', 'x'.repeat(10), {
          'content-type': 'text/plain',
          'x-line-signature': '',
        }),
      );
    });

    test('a validly signed event more than an hour old (a replay) is ignored', async () => {
      const old = JSON.parse(lineMessage('U1', 'unlink')) as { events: { timestamp: number }[] };
      for (const event of old.events) event.timestamp = Date.now() - 61 * 60_000;
      const res = await fromLine(app, JSON.stringify(old));
      expect(res.status).toBe(200);
      expect(fake.hits).toHaveLength(0);
    });

    test('a body over 1 MiB is refused unread', async () => {
      const res = await postCallback(app, 'line', 'x'.repeat(1024 * 1024 + 1), {
        'x-line-signature': 'AAAA',
      });
      expect(res.status).toBe(413);
      expect(fake.hits).toHaveLength(0);
    });
  });

  describe('Slack: v0 signing secret HMAC over the timestamp and raw body', () => {
    test('a valid signature is accepted, and URL verification answers the challenge', async () => {
      expect((await fromSlack(app, slackMessage('W1', 'hello'))).status).toBe(200);
      const res = await fromSlack(
        app,
        JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'legacy' }),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ challenge: 'abc123' });
    });

    test('a missing signature or timestamp is rejected', async () => {
      const body = slackMessage('W1', 'hello');
      const ts = Math.floor(Date.now() / 1000);
      await expectRejected(await postCallback(app, 'slack', body, {}));
      await expectRejected(
        await postCallback(app, 'slack', body, { 'x-slack-signature': slackSignature(body, ts) }),
      );
      await expectRejected(
        await postCallback(app, 'slack', body, { 'x-slack-request-timestamp': String(ts) }),
      );
    });

    test('a signature with another secret, or over another body, is rejected', async () => {
      const body = slackMessage('W1', 'hello');
      const ts = Math.floor(Date.now() / 1000);
      await expectRejected(
        await postCallback(app, 'slack', body, {
          'x-slack-request-timestamp': String(ts),
          'x-slack-signature': slackSignature(body, ts, 'not-the-signing-secret'),
        }),
      );
      await expectRejected(
        await postCallback(app, 'slack', body.replace('hello', 'unlink'), {
          'x-slack-request-timestamp': String(ts),
          'x-slack-signature': slackSignature(body, ts),
        }),
      );
      // The timestamp is signed too: a fresh one can't be put on an old signature.
      await expectRejected(
        await postCallback(app, 'slack', body, {
          'x-slack-request-timestamp': String(ts + 1),
          'x-slack-signature': slackSignature(body, ts),
        }),
      );
    });

    test('a request signed more than 5 minutes ago (a replay) is rejected', async () => {
      const body = slackMessage('W1', 'hello');
      await expectRejected(await fromSlack(app, body, Date.now() - 6 * 60_000));
      await expectRejected(await fromSlack(app, body, Date.now() + 6 * 60_000));
      expect((await fromSlack(app, body, Date.now() - 4 * 60_000)).status).toBe(200);
    });

    test('a replay inside the window does nothing twice', async () => {
      const body = slackMessage('W1', 'hello', 'Ev-replayed');
      await fromSlack(app, body);
      await fromSlack(app, body);
      expect(fake.texts()).toHaveLength(1);
    });
  });

  describe('Teams: a Bot Framework JWT checked against its OpenID keys', () => {
    const activity = () => teamsMessage('29:x', 'hello', fake.serviceUrl);
    const withToken = (token: string, body = activity()) =>
      postCallback(app, 'teams', body, { authorization: `Bearer ${token}` });

    test('a valid token is accepted', async () => {
      expect((await fromTeams(app, fake, activity())).status).toBe(200);
      expect(fake.texts()).toHaveLength(1);
    });

    test('a missing or malformed token is rejected', async () => {
      await expectRejected(await postCallback(app, 'teams', activity(), {}));
      await expectRejected(
        await postCallback(app, 'teams', activity(), { authorization: 'Basic abc' }),
      );
      await expectRejected(await withToken('not.a.jwt'));
      await expectRejected(await withToken('a.b'));
    });

    test('a token signed by another key is rejected', async () => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      // Claiming the published key id, and an unknown one.
      await expectRejected(await withToken(fake.teamsToken({}, { key: privateKey })));
      await expectRejected(
        await withToken(fake.teamsToken({}, { key: privateKey, kid: 'attacker-key' })),
      );
    });

    test('alg "none" and HMAC tokens are rejected', async () => {
      const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const claims = {
        iss: 'https://api.botframework.com',
        aud: TEAMS_CREDENTIALS.appId,
        serviceurl: fake.serviceUrl,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      await expectRejected(
        await withToken(`${encode({ alg: 'none', kid: TEAMS_KID })}.${encode(claims)}.`),
      );
      await expectRejected(await withToken(fake.teamsToken({}, { alg: 'HS256' })));
    });

    test('a token for another bot, from another issuer, or expired is rejected', async () => {
      await expectRejected(
        await withToken(fake.teamsToken({ aud: '99999999-9999-9999-9999-999999999999' })),
      );
      await expectRejected(await withToken(fake.teamsToken({ iss: 'https://evil.example' })));
      const now = Math.floor(Date.now() / 1000);
      await expectRejected(await withToken(fake.teamsToken({ exp: now - 600 })));
      await expectRejected(await withToken(fake.teamsToken({ nbf: now + 600 })));
    });

    test('an activity for another serviceUrl or channel than the token is rejected', async () => {
      // The token names the real connector; the body points replies (and the bot's
      // access token) elsewhere.
      await expectRejected(
        await fromTeams(app, fake, teamsMessage('29:x', 'hello', 'https://evil.example/')),
      );
      await expectRejected(
        await fromTeams(
          app,
          fake,
          teamsMessage('29:x', 'hello', fake.serviceUrl, { channelId: 'webchat' }),
        ),
      );
    });
  });
});
