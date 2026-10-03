import { createHmac } from 'node:crypto';
import type {
  Card,
  CardInput,
  ChatAppAdapter,
  ChatInbound,
  ChatMessage,
  InboundRequest,
  MessageRef,
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

/** The seal red of a Blocker (the web's lacquer), as Slack's attachment bar. */
const BLOCKER_COLOR = '#B8321F';
const DEFAULT_COLOR = '#2F6B5A';
/** The modal that takes a question or an own answer. */
const INPUT_CALLBACK = 'vorasaan_input';

/**
 * Slack Events API. A request is signed with the app's signing secret (v0):
 * `x-slack-signature` = "v0=" + hex HMAC-SHA256 of "v0:{timestamp}:{raw body}", with
 * `x-slack-request-timestamp` within 5 minutes of now, so an old request can't be
 * replayed. Inside the window, a repeat is dropped by its `event_id`. Button presses
 * (`block_actions`) and modal submissions (`view_submission`) arrive form-encoded as
 * `payload=`, signed the same way.
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
    if (request.contentType?.startsWith('application/x-www-form-urlencoded')) {
      return this.parseInteraction(request, credentials);
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
          reply: async (message) => {
            await this.post(credentials, channel, message);
          },
        },
      ],
    };
  }

  /** A button press or a modal submission (ticket 0058). */
  private parseInteraction(request: InboundRequest, credentials: SlackCredentials): ParsedCallback {
    const payload = jsonObject(
      safeJson(
        Buffer.from(new URLSearchParams(request.body.toString('utf8')).get('payload') ?? ''),
      ),
    );
    const user = jsonObject(payload?.user);
    const userId = str(user?.id);
    if (!payload || !userId) return { events: [] };
    const chatUser = {
      id: userId,
      displayName: null,
      address: { teamId: str(user?.team_id) ?? str(jsonObject(payload.team)?.id) ?? '' },
    };
    // Replies go to the person's own direct message with the bot, never to wherever the
    // card may have been shared: posting to a user id opens that conversation.
    const reply = async (message: ChatMessage) => {
      await this.post(credentials, userId, message);
    };

    if (payload.type === 'block_actions') {
      const action = jsonObject(Array.isArray(payload.actions) ? payload.actions[0] : null);
      const token = str(action?.value);
      const triggerId = str(payload.trigger_id);
      // "Open in Vorasaan" is a link button: Slack reports it too, with no value.
      if (!token) return { events: [] };
      const event: ChatInbound = {
        kind: 'action',
        eventId: triggerId ? `trigger:${triggerId}` : null,
        user: chatUser,
        token,
        text: null,
        reply,
        ...(triggerId && {
          openInput: (input: CardInput) => this.openModal(credentials, triggerId, input),
        }),
      };
      return { events: [event] };
    }

    if (payload.type === 'view_submission') {
      const view = jsonObject(payload.view);
      if (str(view?.callback_id) !== INPUT_CALLBACK) return { events: [] };
      const token = str(view?.private_metadata);
      const values = jsonObject(jsonObject(view?.state)?.values);
      const text = str(jsonObject(jsonObject(values?.input)?.text)?.value) ?? '';
      const viewId = str(view?.id);
      if (!token) return { events: [] };
      // An empty body closes the modal; the outcome arrives as a direct message.
      return {
        events: [
          {
            kind: 'action',
            eventId: viewId ? `view:${viewId}` : null,
            user: chatUser,
            token,
            text,
            reply,
          },
        ],
      };
    }
    return { events: [] };
  }

  async send(
    credentials: SlackCredentials,
    account: { providerUserId: string; address: Record<string, string> },
    message: ChatMessage,
  ): Promise<MessageRef | null> {
    // The direct message channel the person wrote from; posting to a user id opens it too.
    return this.post(credentials, account.address.channelId ?? account.providerUserId, message);
  }

  async update(credentials: SlackCredentials, ref: MessageRef, message: ChatMessage) {
    if (!ref.channel || !ref.ts) return;
    await this.call(credentials, 'chat.update', {
      channel: ref.channel,
      ts: ref.ts,
      ...slackMessage(message),
    });
  }

  private async post(
    credentials: SlackCredentials,
    channel: string,
    message: ChatMessage,
  ): Promise<MessageRef | null> {
    const result = await this.call(credentials, 'chat.postMessage', {
      channel,
      ...slackMessage(message),
    });
    const sentChannel = str(result.channel);
    const ts = str(result.ts);
    return sentChannel && ts ? { channel: sentChannel, ts } : null;
  }

  private async openModal(credentials: SlackCredentials, triggerId: string, input: CardInput) {
    await this.call(credentials, 'views.open', {
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: INPUT_CALLBACK,
        // Signed, and checked again when the submission comes back.
        private_metadata: input.token,
        title: plain(input.title, 24),
        submit: plain(input.submit, 24),
        close: plain(input.cancel, 24),
        blocks: [
          {
            type: 'input',
            block_id: 'input',
            label: plain(input.inputLabel, 2000),
            element: {
              type: 'plain_text_input',
              action_id: 'text',
              multiline: true,
              max_length: 3000,
              placeholder: plain(input.placeholder, 150),
            },
          },
        ],
      },
    });
  }

  private async call(credentials: SlackCredentials, method: string, body: object) {
    const result = jsonObject(
      await providerPost('SLACK', `${chatApiUrls().slack}/${method}`, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${credentials.botToken}`,
        },
        body: JSON.stringify(body),
      }),
    );
    // Slack answers 200 with { ok: false } for most failures.
    if (result?.ok !== true) throw new ChatApiError('SLACK', 200);
    return result;
  }
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const plain = (text: string, max: number) => ({
  type: 'plain_text',
  text: truncate(text, max),
  emoji: false,
});

/** Slack mrkdwn: &, < and > are escaped so names and titles can't become links or mentions. */
const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mrkdwn = (text: string, max = 3000) => ({ type: 'mrkdwn', text: truncate(text, max) });

/** A text message, or a card as Block Kit inside a colored attachment (the Blocker bar). */
export function slackMessage(message: ChatMessage): Record<string, unknown> {
  if (!message.card) return { text: message.text };
  return {
    text: message.text,
    attachments: [
      {
        color: message.card.accent === 'blocker' ? BLOCKER_COLOR : DEFAULT_COLOR,
        fallback: truncate(message.text, 3000),
        blocks: slackBlocks(message.card),
      },
    ],
  };
}

export function slackBlocks(card: Card): object[] {
  const blocks: object[] = [
    { type: 'context', elements: [mrkdwn(esc(card.eyebrow))] },
    { type: 'section', text: mrkdwn(`*${esc(card.title)}*`) },
  ];
  if (card.lines.length) {
    blocks.push({ type: 'section', text: mrkdwn(card.lines.map(esc).join('\n')) });
  }
  for (const choice of card.choices) {
    blocks.push({
      type: 'section',
      text: mrkdwn(
        `*${esc(choice.label)}. ${esc(choice.title)}*\n${choice.impact.map(esc).join('\n')}`,
      ),
      accessory: {
        type: 'button',
        action_id: `choice_${choice.label}`,
        text: plain(choice.button.label, 75),
        value: choice.button.token,
        style: 'primary',
      },
    });
  }
  const actions: object[] = [];
  for (const [id, input] of [
    ['ask', card.ask],
    ['own', card.own],
    ['redraft', card.redraft],
  ] as const) {
    if (input) {
      actions.push({
        type: 'button',
        action_id: id,
        text: plain(input.label, 75),
        value: input.token,
      });
    }
  }
  actions.push({
    type: 'button',
    action_id: 'open',
    text: plain(card.link.label, 75),
    url: card.link.url,
  });
  blocks.push({ type: 'actions', elements: actions });
  return blocks;
}

/** Slack escapes &, < and > in message text. */
const unescapeSlack = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
