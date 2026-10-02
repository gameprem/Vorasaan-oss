import { createHmac } from 'node:crypto';
import type {
  ChatAppAdapter,
  ChatMessage,
  InboundRequest,
  ParsedCallback,
  SlackCredentials,
} from './adapter.ts';
import { header } from './adapter.ts';
import {
  ChatApiError,
  chatApiUrls,
  constantTimeEqual,
  jsonObject,
  providerPost,
  safeJson,
  str,
} from './http.ts';

/** Slack refuses requests signed more than 5 minutes away from now; so do we. */
export const SLACK_MAX_AGE_SECONDS = 5 * 60;

/**
 * Slack Events API. A request is signed with the app's signing secret (v0):
 * `x-slack-signature` = "v0=" + hex HMAC-SHA256 of "v0:{timestamp}:{raw body}", with
 * `x-slack-request-timestamp` within 5 minutes of now, so an old request can't be
 * replayed. Inside the window, a repeat is dropped by its `event_id`.
 */
export class SlackAdapter implements ChatAppAdapter<SlackCredentials> {
  readonly provider = 'SLACK' as const;

  async verify(
    request: InboundRequest,
    credentials: SlackCredentials,
    now: Date,
  ): Promise<true | null> {
    const timestamp = header(request, 'x-slack-request-timestamp');
    const signature = header(request, 'x-slack-signature');
    if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return null;
    if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SLACK_MAX_AGE_SECONDS) return null;
    if (!/^v0=[0-9a-f]{64}$/.test(signature)) return null;
    const expected = createHmac('sha256', credentials.signingSecret)
      .update(`v0:${timestamp}:`)
      .update(request.body)
      .digest();
    return constantTimeEqual(Buffer.from(signature.slice(3), 'hex'), expected) ? true : null;
  }

  parse(
    request: InboundRequest,
    _verified: unknown,
    credentials: SlackCredentials,
  ): ParsedCallback | null {
    // Interactive payloads (button presses, ticket 0058) arrive form-encoded.
    if (request.contentType?.startsWith('application/x-www-form-urlencoded')) {
      return { events: [] };
    }
    const body = jsonObject(safeJson(request.body));
    if (!body) return { events: [] };
    if (body.type === 'url_verification') {
      return { events: [], response: { challenge: str(body.challenge) ?? '' } };
    }
    const event = jsonObject(body.event);
    if (body.type !== 'event_callback' || !event) return { events: [] };
    const user = str(event.user);
    const channel = str(event.channel);
    // Direct messages from a person: not the bot itself, not edits or joins.
    if (
      event.type !== 'message' ||
      event.channel_type !== 'im' ||
      event.subtype !== undefined ||
      event.bot_id !== undefined ||
      !user ||
      !channel
    ) {
      return { events: [] };
    }
    const teamId = str(body.team_id) ?? str(event.team) ?? '';
    return {
      events: [
        {
          kind: 'message',
          eventId: str(body.event_id) ?? null,
          user: { id: user, displayName: null, address: { teamId, channelId: channel } },
          text: unescapeSlack(str(event.text) ?? ''),
          reply: (message) => this.post(credentials, channel, message),
        },
      ],
    };
  }

  async send(
    credentials: SlackCredentials,
    account: { providerUserId: string; address: Record<string, string> },
    message: ChatMessage,
  ): Promise<void> {
    // The direct message channel the person wrote from; posting to a user id opens it too.
    await this.post(credentials, account.address.channelId ?? account.providerUserId, message);
  }

  private async post(credentials: SlackCredentials, channel: string, message: ChatMessage) {
    const result = jsonObject(
      await providerPost('SLACK', `${chatApiUrls().slack}/chat.postMessage`, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${credentials.botToken}`,
        },
        body: JSON.stringify({ channel, text: message.text }),
      }),
    );
    // Slack answers 200 with { ok: false } for most failures.
    if (result?.ok !== true) throw new ChatApiError('SLACK', 200);
  }
}

/** Slack escapes &, < and > in message text. */
const unescapeSlack = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
