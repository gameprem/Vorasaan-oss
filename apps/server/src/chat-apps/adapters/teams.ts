import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type {
  ChatAppAdapter,
  ChatInbound,
  ChatMessage,
  InboundRequest,
  ParsedCallback,
  TeamsCredentials,
} from './adapter.ts';
import { header } from './adapter.ts';
import { ChatApiError, chatApiUrls, jsonObject, providerPost, safeJson, str } from './http.ts';
import type { Jwk, TeamsKeySource } from './teams-keys.ts';

/** The issuer of tokens the Bot Framework sends with each activity. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
/** Clock skew allowed on `exp` and `nbf`, as the Bot Framework's own SDKs do. */
const SKEW_SECONDS = 5 * 60;

type Verified = { serviceUrl: string; endorsements: string[] | null };

const fromBase64Url = (part: string) => Buffer.from(part, 'base64url');

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    return jsonObject(JSON.parse(fromBase64Url(part).toString('utf8')));
  } catch {
    return null;
  }
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Bot Framework connector URLs for an activity. */
const activitiesUrl = (serviceUrl: string, conversationId: string, replyToId?: string) =>
  `${serviceUrl.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/activities${
    replyToId ? `/${encodeURIComponent(replyToId)}` : ''
  }`;

/**
 * Microsoft Teams through the Bot Framework. Each activity comes with
 * `Authorization: Bearer <JWT>`: RS256, signed by a key from the Bot Framework's OpenID
 * metadata (JWKS), issued by https://api.botframework.com for our bot app id (the
 * audience), not expired. After parsing, the activity must be for the `serviceUrl` the
 * token names, on a channel its key is endorsed for.
 */
export class TeamsAdapter implements ChatAppAdapter<TeamsCredentials> {
  readonly provider = 'TEAMS' as const;
  /** Bot Framework access tokens for sending, per app id. */
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly keySource: TeamsKeySource) {}

  async verify(
    request: InboundRequest,
    credentials: TeamsCredentials,
    now: Date,
  ): Promise<Verified | null> {
    const authorization = header(request, 'authorization');
    if (!authorization?.startsWith('Bearer ')) return null;
    const parts = authorization.slice(7).trim().split('.');
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (parts.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) return null;
    const jwtHeader = decodeJson(encodedHeader);
    const claims = decodeJson(encodedClaims);
    const kid = str(jwtHeader?.kid);
    // Only RS256: never "none", and never an HMAC keyed with a public key.
    if (!jwtHeader || !claims || jwtHeader.alg !== 'RS256' || !kid) return null;

    const key = await this.key(kid);
    if (!key?.n || !key.e || key.kty !== 'RSA') return null;
    let valid = false;
    try {
      valid = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' }),
        fromBase64Url(encodedSignature),
      );
    } catch {
      return null;
    }
    if (!valid) return null;

    const seconds = now.getTime() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== BOT_FRAMEWORK_ISSUER) return null;
    if (!audience.includes(credentials.appId)) return null;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < seconds) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > seconds) return null;
    // The Bot Framework names the claim "serviceurl"; accept the camel-case spelling too.
    const serviceUrl = str(claims.serviceurl) ?? str(claims.serviceUrl);
    if (!serviceUrl) return null;
    return {
      serviceUrl,
      endorsements: Array.isArray(key.endorsements) ? key.endorsements : null,
    };
  }

  private async key(kid: string): Promise<Jwk | undefined> {
    const find = (keys: Jwk[]) => keys.find((k) => k.kid === kid);
    return find(await this.keySource.keys()) ?? find(await this.keySource.keys(true));
  }

  parse(
    request: InboundRequest,
    verified: unknown,
    credentials: TeamsCredentials,
  ): ParsedCallback | null {
    const { serviceUrl, endorsements } = verified as Verified;
    const activity = jsonObject(safeJson(request.body));
    if (!activity) return { events: [] };
    // The token is only good for the connector it names, and the channel its key signs for.
    const activityServiceUrl = str(activity.serviceUrl);
    if (!activityServiceUrl || !sameUrl(activityServiceUrl, serviceUrl)) return null;
    const channelId = str(activity.channelId);
    if (endorsements && (!channelId || !endorsements.includes(channelId))) return null;

    const from = jsonObject(activity.from);
    const conversation = jsonObject(activity.conversation);
    const recipient = jsonObject(activity.recipient);
    const userId = str(from?.id);
    const conversationId = str(conversation?.id);
    const eventId = str(activity.id) ?? null;
    if (!userId || !conversationId) return { events: [] };
    // Only one-to-one chats with the bot: in a channel, anyone could read the reply.
    const conversationType = str(conversation?.conversationType) ?? 'personal';
    if (conversationType !== 'personal') return { events: [] };

    const events: ChatInbound[] = [];
    if (activity.type === 'installationUpdate' && activity.action === 'remove') {
      events.push({ kind: 'unlinked', eventId, userId });
    } else if (activity.type === 'message') {
      const replyTo = eventId ?? undefined;
      events.push({
        kind: 'message',
        eventId,
        user: {
          id: userId,
          displayName: str(from?.name) ?? null,
          address: {
            serviceUrl,
            conversationId,
            tenantId:
              str(conversation?.tenantId) ??
              str(jsonObject(jsonObject(activity.channelData)?.tenant)?.id) ??
              '',
            botId: str(recipient?.id) ?? '',
          },
        },
        text: teamsText(str(activity.text) ?? ''),
        reply: (message) =>
          this.post(credentials, activitiesUrl(serviceUrl, conversationId, replyTo), {
            type: 'message',
            text: message.text,
            ...(replyTo ? { replyToId: replyTo } : {}),
          }),
      });
    }
    return { events };
  }

  async send(
    credentials: TeamsCredentials,
    account: { address: Record<string, string> },
    message: ChatMessage,
  ): Promise<void> {
    const { serviceUrl, conversationId } = account.address;
    if (!serviceUrl || !conversationId) throw new ChatApiError('TEAMS', null);
    await this.post(credentials, activitiesUrl(serviceUrl, conversationId), {
      type: 'message',
      text: message.text,
    });
  }

  private async post(credentials: TeamsCredentials, url: string, activity: object) {
    await providerPost('TEAMS', url, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.accessToken(credentials)}`,
      },
      body: JSON.stringify(activity),
    });
  }

  /** A Bot Framework token for the bot (client credentials), cached until shortly before expiry. */
  private async accessToken(credentials: TeamsCredentials): Promise<string> {
    const cached = this.tokens.get(credentials.appId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const result = jsonObject(
      await providerPost('TEAMS', chatApiUrls().teamsToken, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: credentials.appId,
          client_secret: credentials.appPassword,
          scope: 'https://api.botframework.com/.default',
        }).toString(),
      }),
    );
    const token = str(result?.access_token);
    if (!token) throw new ChatApiError('TEAMS', null);
    const expiresIn = typeof result?.expires_in === 'number' ? result.expires_in : 3600;
    this.tokens.set(credentials.appId, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
  }

  /** Forgets cached tokens, e.g. after an Admin changes the bot's password. */
  forgetTokens(): void {
    this.tokens.clear();
  }
}

/** Teams sends HTML-ish text (mentions as <at>…</at>); keep the words. */
function teamsText(text: string): string {
  return text
    .replace(/<at>[^<]*<\/at>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
