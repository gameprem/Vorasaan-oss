import type { ChatProvider } from '@vorasaan/shared';

// One adapter per chat app (ADR 0011). Each knows how its provider signs callbacks,
// what a callback says, and how to send a message. The rest of Vorasaan sees only
// these shapes, so ticket 0058 adds cards (a richer ChatMessage) and button presses
// (a new ChatInbound kind) without touching how callbacks are verified.

export type LineCredentials = { channelAccessToken: string; channelSecret: string };
export type SlackCredentials = { botToken: string; signingSecret: string };
export type TeamsCredentials = { appId: string; appPassword: string };

export type ChatCredentials = {
  LINE: LineCredentials;
  SLACK: SlackCredentials;
  TEAMS: TeamsCredentials;
};

/** A callback as received: the raw bytes, before anything has parsed them. */
export type InboundRequest = {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  contentType: string | undefined;
};

/** Where to reach a person in the chat app; stored on their ChatAccount. */
export type ChatAddress = Record<string, string>;

/** A person in the chat app, as the provider identifies them. */
export type ChatUser = {
  /** Stable per provider (and per bot): LINE userId, Slack user id, Teams from.id. */
  id: string;
  displayName: string | null;
  address: ChatAddress;
};

/** What Vorasaan sends. Ticket 0058 adds cards (Flex Message, Block Kit, Adaptive Card). */
export type ChatMessage = { text: string };

export type ChatInbound =
  /** The person wrote to the bot (a link code, "unlink", anything else). */
  | {
      kind: 'message';
      /** The provider's id of this event, to drop a redelivery. */
      eventId: string | null;
      user: ChatUser;
      text: string;
      /** Answers in the same conversation. */
      reply: (message: ChatMessage) => Promise<void>;
    }
  /** The person removed or blocked the bot: their link ends. */
  | { kind: 'unlinked'; eventId: string | null; userId: string };
// Ticket 0058: | { kind: 'action'; eventId; user; action: { requestId, choiceId, ... }; reply }

/** A verified, parsed callback. */
export type ParsedCallback = {
  events: ChatInbound[];
  /** A body the provider expects back (Slack's URL verification challenge). */
  response?: unknown;
};

export interface ChatAppAdapter<C> {
  readonly provider: ChatProvider;

  /**
   * Checks the provider's signature over the raw bytes, and its freshness where the
   * provider gives one. Must not parse or act on the body. Returns what the parse step
   * needs to bind the body to the signature (Teams: the token's claims), or null.
   */
  verify(request: InboundRequest, credentials: C, now: Date): Promise<unknown | null>;

  /**
   * Parses a verified callback. Returns null when the body contradicts what was
   * verified (Teams: a serviceUrl the token wasn't issued for), which counts as unsigned.
   */
  parse(request: InboundRequest, verified: unknown, credentials: C): ParsedCallback | null;

  /** Sends to a linked account, outside any conversation turn (unlink notices; 0058 cards). */
  send(
    credentials: C,
    account: { providerUserId: string; address: ChatAddress },
    message: ChatMessage,
  ): Promise<void>;
}

export const header = (request: InboundRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
