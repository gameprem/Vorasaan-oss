import type { ChatProvider } from '@vorasaan/shared';

// One adapter per chat app (ADR 0011). Each knows how its provider signs callbacks,
// what a callback says, and how to send a message or a card. The rest of Vorasaan sees
// only these shapes: a provider-neutral Card (ticket 0058) that each adapter renders as
// a LINE Flex Message, Slack Block Kit or a Teams Adaptive Card, and button presses as
// `action` events.

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

/** A button on a card. `token` is a signed ActionToken (see action-token.ts). */
export type CardButton = { label: string; token: string };

/** A text input behind a button: a Slack modal, a Teams card input, a LINE reply prompt. */
export type CardInput = CardButton & {
  title: string;
  inputLabel: string;
  placeholder: string;
  submit: string;
  cancel: string;
};

/**
 * A card, before a provider renders it. It carries only what ADR 0011 allows: the
 * request's title, its Choices with their impact, short status lines and a link to
 * Vorasaan, never a description or Attachment contents.
 */
export type Card = {
  /** Seal red for a Blocker. */
  accent: 'blocker' | 'default';
  /** Above the title: "Blocker · Checkout", "Reminder: waiting for your decision". */
  eyebrow: string;
  title: string;
  /** Short lines under the title: who raised it, the due time, a question or answer. */
  lines: string[];
  choices: {
    label: string;
    title: string;
    /** "Scope: …", "Time: …", "Risk: …". */
    impact: string[];
    button: CardButton;
  }[];
  ask: CardInput | null;
  own: CardInput | null;
  /** Request changes (ticket 0065): its text is the feedback the AI redrafts from. */
  redraft: CardInput | null;
  /** A shorter label for "Write your own answer" where buttons are narrow (LINE: 20). */
  ownShortLabel: string;
  link: { label: string; url: string };
};

/** What Vorasaan sends: text, or a card with `text` as its notification and fallback. */
export type ChatMessage = { text: string; card?: Card };

/** Where a provider put a sent message, to update it later (Slack and Teams). */
export type MessageRef = Record<string, string>;

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
  | { kind: 'unlinked'; eventId: string | null; userId: string }
  /**
   * The person pressed a card's button, or sent the text input behind one. Only the
   * signed token comes from the card; who pressed is `user.id`, as the provider verified.
   */
  | {
      kind: 'action';
      eventId: string | null;
      user: ChatUser;
      /** The button's ActionToken, unverified until ActionTokens.verify. */
      token: string;
      /** Typed into the card's input or modal (Teams, Slack), else null. */
      text: string | null;
      reply: (message: ChatMessage) => Promise<void>;
      /**
       * Opens the provider's text input for this button (Slack: a modal). Absent where
       * the text arrives with the press (Teams) or as the next message (LINE).
       */
      openInput?: (input: CardInput) => Promise<void>;
    };

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

  /**
   * Sends to a linked account, outside any conversation turn (cards, unlink notices).
   * Returns where the message went when the provider can update it later.
   */
  send(
    credentials: C,
    account: { providerUserId: string; address: ChatAddress },
    message: ChatMessage,
  ): Promise<MessageRef | null>;

  /** Replaces a sent card (after a press), where the provider allows it. LINE can't. */
  update(credentials: C, ref: MessageRef, message: ChatMessage): Promise<void>;
}

export const header = (request: InboundRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
