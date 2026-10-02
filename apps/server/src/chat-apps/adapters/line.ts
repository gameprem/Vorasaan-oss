import { createHmac } from 'node:crypto';
import type {
  ChatAppAdapter,
  ChatInbound,
  ChatMessage,
  InboundRequest,
  LineCredentials,
  ParsedCallback,
} from './adapter.ts';
import { header } from './adapter.ts';
import { chatApiUrls, constantTimeEqual, jsonObject, providerPost, safeJson, str } from './http.ts';

/**
 * How old a LINE event may be. LINE signs no request timestamp, but each event carries
 * one inside the signed body: an older event (a captured webhook replayed later) is
 * dropped, and within this age a repeat is dropped by its `webhookEventId` (SeenEvents
 * remembers ids for longer than this).
 */
export const LINE_MAX_EVENT_AGE_MS = 60 * 60 * 1000;

/**
 * LINE Messaging API. A webhook is signed with `x-line-signature`: the base64
 * HMAC-SHA256 of the raw body, keyed with the channel secret.
 */
export class LineAdapter implements ChatAppAdapter<LineCredentials> {
  readonly provider = 'LINE' as const;

  async verify(
    request: InboundRequest,
    credentials: LineCredentials,
    now: Date,
  ): Promise<{ receivedAt: number } | null> {
    const signature = header(request, 'x-line-signature');
    if (!signature) return null;
    const expected = createHmac('sha256', credentials.channelSecret).update(request.body).digest();
    return constantTimeEqual(Buffer.from(signature, 'base64'), expected)
      ? { receivedAt: now.getTime() }
      : null;
  }

  parse(
    request: InboundRequest,
    verified: unknown,
    credentials: LineCredentials,
  ): ParsedCallback | null {
    const { receivedAt } = verified as { receivedAt: number };
    const body = jsonObject(safeJson(request.body));
    if (!body) return { events: [] };
    const events: ChatInbound[] = [];
    for (const raw of Array.isArray(body.events) ? body.events : []) {
      const event = jsonObject(raw);
      const source = jsonObject(event?.source);
      const userId = str(source?.userId);
      // Only one-to-one chats with the bot: in a group, anyone could read the reply.
      if (!event || source?.type !== 'user' || !userId) continue;
      if (event.mode === 'standby') continue;
      const sentAt = typeof event.timestamp === 'number' ? event.timestamp : 0;
      if (receivedAt - sentAt > LINE_MAX_EVENT_AGE_MS) continue;
      const eventId = str(event.webhookEventId) ?? null;
      if (event.type === 'unfollow') {
        events.push({ kind: 'unlinked', eventId, userId });
        continue;
      }
      const message = jsonObject(event.message);
      const replyToken = str(event.replyToken);
      if (event.type !== 'message' || message?.type !== 'text' || !replyToken) continue;
      events.push({
        kind: 'message',
        eventId,
        user: { id: userId, displayName: null, address: {} },
        text: str(message.text) ?? '',
        reply: (reply) => this.reply(credentials, replyToken, reply),
      });
    }
    return { events };
  }

  private async reply(credentials: LineCredentials, replyToken: string, message: ChatMessage) {
    await providerPost('LINE', `${chatApiUrls().line}/v2/bot/message/reply`, {
      headers: this.headers(credentials),
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message.text }] }),
    });
  }

  async send(
    credentials: LineCredentials,
    account: { providerUserId: string },
    message: ChatMessage,
  ): Promise<void> {
    await providerPost('LINE', `${chatApiUrls().line}/v2/bot/message/push`, {
      headers: this.headers(credentials),
      body: JSON.stringify({
        to: account.providerUserId,
        messages: [{ type: 'text', text: message.text }],
      }),
    });
  }

  private headers(credentials: LineCredentials) {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.channelAccessToken}`,
    };
  }
}
