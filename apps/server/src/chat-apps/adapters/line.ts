import { createHmac } from 'node:crypto';
import type {
  Card,
  ChatAppAdapter,
  ChatInbound,
  ChatMessage,
  InboundRequest,
  LineCredentials,
  MessageRef,
  ParsedCallback,
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

/**
 * How old a LINE event may be. LINE signs no request timestamp, but each event carries
 * one inside the signed body: an older event (a captured webhook replayed later) is
 * dropped, and within this age a repeat is dropped by its `webhookEventId` (SeenEvents
 * remembers ids for longer than this).
 */
export const LINE_MAX_EVENT_AGE_MS = 60 * 60 * 1000;

/**
 * LINE Messaging API. A webhook is signed with `x-line-signature`: the base64
 * HMAC-SHA256 of the raw body, keyed with the channel secret. A card's button press
 * arrives as a `postback` event (ticket 0058).
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
      const replyToken = str(event.replyToken);
      if (!replyToken) continue;
      const user = { id: userId, displayName: null, address: {} };
      const reply = (message: ChatMessage) => this.reply(credentials, replyToken, userId, message);
      // A card's button (ticket 0058). Its text input is the person's next message.
      if (event.type === 'postback') {
        const data = str(jsonObject(event.postback)?.data);
        if (data) events.push({ kind: 'action', eventId, user, token: data, text: null, reply });
        continue;
      }
      const message = jsonObject(event.message);
      if (event.type !== 'message' || message?.type !== 'text') continue;
      events.push({ kind: 'message', eventId, user, text: str(message.text) ?? '', reply });
    }
    return { events };
  }

  /**
   * Answers with the event's reply token. A press is answered once the Decision is
   * recorded, which may outlast the token (short-lived, and good once), so a refused
   * reply falls back to a push to the same person.
   */
  private async reply(
    credentials: LineCredentials,
    replyToken: string,
    userId: string,
    message: ChatMessage,
  ) {
    try {
      await providerPost('LINE', `${chatApiUrls().line}/v2/bot/message/reply`, {
        headers: this.headers(credentials),
        body: JSON.stringify({ replyToken, messages: [lineMessage(message)] }),
      });
    } catch (error) {
      if (!(error instanceof ChatApiError) || error.status !== 400) throw error;
      await this.send(credentials, { providerUserId: userId }, message);
    }
  }

  async send(
    credentials: LineCredentials,
    account: { providerUserId: string },
    message: ChatMessage,
  ): Promise<MessageRef | null> {
    await providerPost('LINE', `${chatApiUrls().line}/v2/bot/message/push`, {
      headers: this.headers(credentials),
      body: JSON.stringify({ to: account.providerUserId, messages: [lineMessage(message)] }),
    });
    return null;
  }

  /** LINE can't edit a sent message: the reply to the press says what happened instead. */
  async update(): Promise<void> {}

  private headers(credentials: LineCredentials) {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.channelAccessToken}`,
    };
  }
}

/** The seal red of a Blocker (the web's lacquer). */
const BLOCKER_COLOR = '#B8321F';
const ACCENT = '#2F6B5A';
const INK = '#2B2620';
const SOFT = '#6B6255';

/** Cuts by characters (code points), so Thai and emoji are never split in half. */
const truncate = (value: string, max: number) => {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
};

const text = (value: string, extra: Record<string, unknown> = {}) => ({
  type: 'text',
  text: truncate(value || ' ', 2000),
  wrap: true,
  ...extra,
});

/** A text message, or a card as a Flex Message with `text` as its alt text. */
export function lineMessage(message: ChatMessage): object {
  return message.card
    ? { type: 'flex', altText: truncate(message.text, 400), contents: lineBubble(message.card) }
    : { type: 'text', text: truncate(message.text, 5000) };
}

/** One bubble. Postback buttons carry the signed token; LINE labels hold 20 characters. */
export function lineBubble(card: Card): object {
  const blocker = card.accent === 'blocker';
  const postback = (label: string, data: string, primary: boolean) => ({
    type: 'button',
    style: primary ? 'primary' : 'secondary',
    height: 'sm',
    ...(primary && { color: blocker ? BLOCKER_COLOR : ACCENT }),
    action: {
      type: 'postback',
      label: truncate(label, 20),
      data,
      displayText: truncate(label, 300),
    },
  });
  const body: object[] = [text(card.title, { weight: 'bold', size: 'md', color: INK })];
  for (const line of card.lines) body.push(text(line, { size: 'xs', color: SOFT }));
  for (const choice of card.choices) {
    body.push({ type: 'separator', margin: 'md' });
    body.push(
      text(`${choice.label}. ${choice.title}`, { weight: 'bold', size: 'sm', margin: 'md' }),
    );
    for (const line of choice.impact) body.push(text(line, { size: 'xs', color: SOFT }));
  }
  const footer: object[] = card.choices.map((c) => postback(c.button.label, c.button.token, true));
  if (card.ask) footer.push(postback(card.ask.label, card.ask.token, false));
  if (card.own) footer.push(postback(card.ownShortLabel, card.own.token, false));
  footer.push({
    type: 'button',
    style: 'link',
    height: 'sm',
    action: { type: 'uri', label: truncate(card.link.label, 20), uri: card.link.url },
  });
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: blocker ? BLOCKER_COLOR : '#F3EFE6',
      contents: [
        text(card.eyebrow, { size: 'xs', weight: 'bold', color: blocker ? '#FFFFFF' : SOFT }),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer },
  };
}
