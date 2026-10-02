import { createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

// Fake LINE, Slack and Bot Framework (Teams) servers for chat app tests, and the
// signatures each real provider puts on its callbacks.

export type ProviderHit = {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
};

export const LINE_CREDENTIALS = {
  channelAccessToken: 'line-access-token-SECRET-0001',
  channelSecret: 'line-channel-secret-SECRET-0002',
};
export const SLACK_CREDENTIALS = {
  botToken: 'xoxb-slack-bot-token-SECRET-0003',
  signingSecret: 'slack-signing-secret-SECRET-0004',
};
export const TEAMS_APP_ID = '3f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f';
export const TEAMS_CREDENTIALS = { appId: TEAMS_APP_ID, appPassword: 'teams-password-SECRET-0005' };
/** Every secret the tests use: none may ever show up in a response or a log line. */
export const ALL_SECRETS = [
  ...Object.values(LINE_CREDENTIALS),
  ...Object.values(SLACK_CREDENTIALS),
  TEAMS_CREDENTIALS.appPassword,
];

const TEAMS_ACCESS_TOKEN = 'bot-framework-access-token';
export const TEAMS_KID = 'fake-key-1';

/**
 * One server playing all three providers' APIs:
 * - LINE: /v2/bot/message/reply and /push
 * - Slack: /api/chat.postMessage
 * - Teams: /teams/token (client credentials), /openid + /keys (JWKS), and the connector
 *   at /connector/v3/conversations/... (the activities' serviceUrl).
 */
export class FakeChatProviders {
  readonly hits: ProviderHit[] = [];
  /** Status to answer API calls with (not the JWKS), to simulate failures. */
  status = 200;
  /** A status for one path only (e.g. an expired LINE reply token: 400 on /reply). */
  readonly statusFor = new Map<string, number>();
  private sent = 0;
  readonly teamsKey: { privateKey: KeyObject; publicJwk: Record<string, unknown> };
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.teamsKey = {
      privateKey,
      publicJwk: {
        ...publicKey.export({ format: 'jwk' }),
        kid: TEAMS_KID,
        use: 'sig',
        endorsements: ['msteams'],
      },
    };
  }

  get url(): string {
    if (!this.server) throw new Error('not started');
    return this.server.url.origin;
  }

  get serviceUrl(): string {
    return `${this.url}/connector/`;
  }

  start(): this {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/openid') return Response.json({ jwks_uri: `${this.url}/keys` });
        if (url.pathname === '/keys') return Response.json({ keys: [this.teamsKey.publicJwk] });
        const body = await req.text();
        this.hits.push({
          method: req.method,
          path: url.pathname,
          authorization: req.headers.get('authorization'),
          body,
        });
        const status = this.statusFor.get(url.pathname) ?? this.status;
        if (status !== 200) return new Response('nope', { status });
        if (url.pathname === '/teams/token') {
          return Response.json({ access_token: TEAMS_ACCESS_TOKEN, expires_in: 3600 });
        }
        if (url.pathname === '/api/chat.postMessage') {
          const { channel } = JSON.parse(body) as { channel: string };
          return Response.json({ ok: true, channel, ts: `1700000000.${++this.sent}` });
        }
        if (url.pathname.startsWith('/api/')) return Response.json({ ok: true });
        // Teams connector: a new activity gets an id (to update it later).
        if (req.method === 'POST' && url.pathname.endsWith('/activities')) {
          return Response.json({ id: `bot-act-${++this.sent}` });
        }
        return Response.json({});
      },
    });
    process.env.VORASAAN_LINE_API_URL = this.url;
    process.env.VORASAAN_SLACK_API_URL = `${this.url}/api`;
    process.env.VORASAAN_TEAMS_TOKEN_URL = `${this.url}/teams/token`;
    process.env.VORASAAN_TEAMS_OPENID_URL = `${this.url}/openid`;
    return this;
  }

  stop() {
    this.server?.stop(true);
  }

  /** The messages sent to people (or those `include` keeps), as text, in order. */
  texts(include: (hit: ProviderHit) => boolean = () => true): string[] {
    return this.hits
      .filter((h) => !h.path.startsWith('/teams/token') && include(h))
      .map((h) => {
        const body = JSON.parse(h.body) as {
          text?: string;
          summary?: string;
          messages?: { text?: string; altText?: string }[];
        };
        const line = body.messages?.[0];
        return body.text ?? body.summary ?? line?.text ?? line?.altText ?? '';
      });
  }

  /** The JSON bodies sent to a path (e.g. '/api/chat.postMessage'), in order. */
  sentTo<T = Record<string, unknown>>(path: string | ((path: string) => boolean)): T[] {
    const match = typeof path === 'string' ? (p: string) => p === path : path;
    return this.hits.filter((h) => match(h.path)).map((h) => JSON.parse(h.body) as T);
  }

  /** A Bot Framework JWT for the activity, signed with the fake JWKS key unless overridden. */
  teamsToken(
    claims: Record<string, unknown> = {},
    options: { key?: KeyObject; kid?: string; alg?: string } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: options.alg ?? 'RS256', typ: 'JWT', kid: options.kid ?? TEAMS_KID };
    const payload = {
      iss: 'https://api.botframework.com',
      aud: TEAMS_APP_ID,
      serviceurl: this.serviceUrl,
      nbf: now - 10,
      exp: now + 3600,
      ...claims,
    };
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${encode(header)}.${encode(payload)}`;
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(input),
      options.key ?? this.teamsKey.privateKey,
    );
    return `${input}.${signature.toString('base64url')}`;
  }
}

// ─── Callbacks as each provider signs them ─────────────────────────────────

export function lineSignature(body: string, secret = LINE_CREDENTIALS.channelSecret): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

let lineEvent = 0;

/** A LINE webhook body with one text message from `userId`. */
export function lineMessage(userId: string, text: string, eventId = `line-${++lineEvent}`) {
  return JSON.stringify({
    destination: 'Ubot',
    events: [
      {
        type: 'message',
        mode: 'active',
        webhookEventId: eventId,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        replyToken: `reply-${eventId}`,
        message: { id: '1', type: 'text', text },
      },
    ],
  });
}

export function lineUnfollow(userId: string) {
  return JSON.stringify({
    destination: 'Ubot',
    events: [
      {
        type: 'unfollow',
        mode: 'active',
        webhookEventId: `line-${++lineEvent}`,
        timestamp: Date.now(),
        source: { type: 'user', userId },
      },
    ],
  });
}

export function slackSignature(
  body: string,
  timestamp: number,
  secret = SLACK_CREDENTIALS.signingSecret,
): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

let slackEvent = 0;

export function slackMessage(user: string, text: string, eventId = `Ev${++slackEvent}`) {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T0001',
    event_id: eventId,
    event: { type: 'message', channel_type: 'im', channel: `D-${user}`, user, text, ts: '1.2' },
  });
}

let teamsActivity = 0;

export function teamsMessage(
  fromId: string,
  text: string,
  serviceUrl: string,
  over: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: 'message',
    id: `act-${++teamsActivity}`,
    channelId: 'msteams',
    serviceUrl,
    from: { id: fromId, name: 'Beam Teams', aadObjectId: 'aad-1' },
    recipient: { id: `28:${TEAMS_APP_ID}`, name: 'Vorasaan' },
    conversation: { id: `a:conv-${fromId}`, conversationType: 'personal', tenantId: 'tenant-1' },
    text,
    ...over,
  });
}

/** POSTs a callback as the provider would, returning the status and body. */
export async function postCallback(
  app: NestFastifyApplication,
  provider: 'line' | 'slack' | 'teams',
  body: string,
  headers: Record<string, string>,
) {
  const res = await app.inject({
    method: 'POST',
    url: `/chat-apps/${provider}/events`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
  return { status: res.statusCode, body: res.body };
}

/** A callback from LINE, correctly signed. */
export const fromLine = (app: NestFastifyApplication, body: string) =>
  postCallback(app, 'line', body, { 'x-line-signature': lineSignature(body) });

/** A callback from Slack, correctly signed now. */
export const fromSlack = (app: NestFastifyApplication, body: string, at = Date.now()) => {
  const timestamp = Math.floor(at / 1000);
  return postCallback(app, 'slack', body, {
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': slackSignature(body, timestamp),
  });
};

/** A callback from Teams with a valid Bot Framework token. */
export const fromTeams = (app: NestFastifyApplication, fake: FakeChatProviders, body: string) =>
  postCallback(app, 'teams', body, { authorization: `Bearer ${fake.teamsToken()}` });

// ─── Button presses (ticket 0058) ──────────────────────────────────────────

/** A LINE postback: a Flex Message button pressed by `userId`. */
export function linePostback(userId: string, data: string, eventId = `line-${++lineEvent}`) {
  return JSON.stringify({
    destination: 'Ubot',
    events: [
      {
        type: 'postback',
        mode: 'active',
        webhookEventId: eventId,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        replyToken: `reply-${eventId}`,
        postback: { data },
      },
    ],
  });
}

let slackTrigger = 0;

/** Slack block_actions: a Block Kit button pressed by `user`, form-encoded as Slack sends it. */
export function slackAction(user: string, value: string, over: { triggerId?: string } = {}) {
  const payload = {
    type: 'block_actions',
    user: { id: user, team_id: 'T0001' },
    team: { id: 'T0001' },
    api_app_id: 'A0001',
    trigger_id: over.triggerId ?? `trigger-${++slackTrigger}`,
    container: { type: 'message', channel_id: `D-${user}`, message_ts: '1.1' },
    channel: { id: `D-${user}` },
    actions: [{ type: 'button', action_id: 'choice_B', value, action_ts: '1.2' }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

/** Slack view_submission: the modal behind a button, sent with `text`. */
export function slackViewSubmission(user: string, privateMetadata: string, text: string) {
  const payload = {
    type: 'view_submission',
    user: { id: user, team_id: 'T0001' },
    team: { id: 'T0001' },
    trigger_id: `trigger-${++slackTrigger}`,
    view: {
      id: `V${slackTrigger}`,
      callback_id: 'vorasaan_input',
      private_metadata: privateMetadata,
      state: { values: { input: { text: { type: 'plain_text_input', value: text } } } },
    },
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

/** A Teams Action.Submit from an Adaptive Card: its data (and input) as `value`. */
export function teamsSubmit(
  fromId: string,
  value: Record<string, unknown>,
  serviceUrl: string,
  replyToId = 'bot-act-1',
) {
  return teamsMessage(fromId, '', serviceUrl, { value, replyToId });
}

/** A Slack interactive payload, form-encoded and signed now. */
export const fromSlackForm = (app: NestFastifyApplication, body: string, at = Date.now()) => {
  const timestamp = Math.floor(at / 1000);
  return postCallback(app, 'slack', body, {
    'content-type': 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': slackSignature(body, timestamp),
  });
};
