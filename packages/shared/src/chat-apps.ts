import { z } from 'zod';
import { ChatEventKind, ChatProvider } from './enums.ts';
import { minutesOfDay, TimeOfDay, TimeZone } from './response-window.ts';

// Chat apps (ADR 0011, tickets 0057 and 0058): an Admin turns on LINE, Slack or Teams,
// and each person links their own account with a one-time code. Then Decision Requests
// arrive there as cards whose buttons decide (ticket 0058).

const Timestamp = z.iso.datetime();

export const CHAT_PROVIDER_LABEL: Record<ChatProvider, string> = {
  LINE: 'LINE',
  SLACK: 'Slack',
  TEAMS: 'Microsoft Teams',
};

/** The lower-case path segment of a chat app: `/chat-apps/line/events`. */
export const ChatProviderSlug = z.enum(['line', 'slack', 'teams']);
export type ChatProviderSlug = z.infer<typeof ChatProviderSlug>;

export const chatProviderSlug = (provider: ChatProvider): ChatProviderSlug =>
  provider.toLowerCase() as ChatProviderSlug;

export const chatProviderOfSlug = (slug: ChatProviderSlug): ChatProvider =>
  slug.toUpperCase() as ChatProvider;

/** Where a chat app sends its events (webhook), relative to the API's public URL. */
export const chatEventsPath = (provider: ChatProvider) =>
  `/chat-apps/${chatProviderSlug(provider)}/events`;

/** How long a link code is valid. */
export const CHAT_LINK_CODE_MINUTES = 10;

/** What goes to chat apps until a person chooses: Decision Requests and NEEDS_INFO. */
export const DEFAULT_CHAT_EVENTS: readonly ChatEventKind[] = ['DECISION_REQUEST', 'NEEDS_INFO'];

export const CHAT_EVENT_LABEL: Record<ChatEventKind, string> = {
  DECISION_REQUEST: 'Decision Requests sent to me',
  NEEDS_INFO: 'Requests for more info on my Decision Requests (NEEDS_INFO)',
  SPEC_PROPOSAL: 'Spec Proposals to approve (a link to Vorasaan)',
  ESCALATION: 'Response Window reminders and overdue notices',
};

const Secret = (message: string) => z.string().trim().min(1, message).max(4096);

/**
 * `PUT /settings/chat-apps` (Admins): turns a chat app on, or changes its credentials.
 * A secret left out keeps the stored one; the first save needs them all. Secrets are
 * stored encrypted and never returned.
 */
export const ChatAppSettingsInput = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('LINE'),
    channelAccessToken: Secret('Enter the channel access token').optional(),
    channelSecret: Secret('Enter the channel secret').optional(),
  }),
  z.strictObject({
    provider: z.literal('SLACK'),
    botToken: Secret('Enter the bot token')
      .refine((t) => t.startsWith('xoxb-'), 'A Slack bot token starts with xoxb-')
      .optional(),
    signingSecret: Secret('Enter the signing secret').optional(),
  }),
  z.strictObject({
    provider: z.literal('TEAMS'),
    appId: z.guid('The bot app id looks like 00000000-0000-0000-0000-000000000000'),
    appPassword: Secret('Enter the bot app password').optional(),
  }),
]);
export type ChatAppSettingsInput = z.infer<typeof ChatAppSettingsInput>;

/** One chat app's setup. Its secrets are never returned, only whether they are set. */
export const ChatAppSettingsView = z.object({
  provider: ChatProvider,
  enabled: z.boolean(),
  /** Microsoft Teams: the bot app id (not a secret). */
  appId: z.string().nullable(),
  secretsSet: z.boolean(),
  eventsPath: z.string(),
  /** People who linked an account in this chat app. */
  linkedAccounts: z.int().min(0),
  updatedAt: Timestamp.nullable(),
});
export type ChatAppSettingsView = z.infer<typeof ChatAppSettingsView>;

/** `GET /settings/chat-apps` (Admins): LINE, Slack and Teams, in that order. */
export const ChatAppsSettingsView = z.object({ apps: z.array(ChatAppSettingsView) });
export type ChatAppsSettingsView = z.infer<typeof ChatAppsSettingsView>;

/** Quiet hours in the person's time zone; the end may be before the start (overnight). */
export const QuietHours = z
  .strictObject({ start: TimeOfDay, end: TimeOfDay })
  .refine((q) => minutesOfDay(q.start) !== minutesOfDay(q.end), {
    message: 'Quiet hours must start and end at different times',
    path: ['end'],
  });
export type QuietHours = z.infer<typeof QuietHours>;

/** The language of a person's cards and bot replies (ticket 0058). */
export const ChatLanguage = z.enum(['en', 'th']);
export type ChatLanguage = z.infer<typeof ChatLanguage>;

/**
 * A new Organization's language, until setup or an Admin picks another (ticket 0063). Each
 * person's cards and bot replies are in their own language, else the Organization's.
 */
export const DEFAULT_CHAT_LANGUAGE: ChatLanguage = 'en';

export const CHAT_LANGUAGE_LABEL: Record<ChatLanguage, string> = {
  en: 'English',
  th: 'ไทย (Thai)',
};

/** `PUT /me/chat-preferences`: what goes to my chat apps, and when not. */
export const ChatPreferencesInput = z.strictObject({
  events: z
    .array(ChatEventKind)
    .max(ChatEventKind.options.length)
    .refine((list) => new Set(list).size === list.length, 'An event appears twice'),
  quietHours: QuietHours.nullable(),
  /** null: the Organization's time zone. */
  timeZone: TimeZone.nullable(),
  /** The language of cards and bot replies; null: the Organization's. Left out: unchanged. */
  language: ChatLanguage.nullable().optional(),
});
export type ChatPreferencesInput = z.infer<typeof ChatPreferencesInput>;

export const ChatPreferencesView = z.object({
  events: z.array(ChatEventKind),
  quietHours: z.object({ start: TimeOfDay, end: TimeOfDay }).nullable(),
  timeZone: z.string().nullable(),
  /** The time zone quiet hours are counted in: the person's own, or the Organization's. */
  effectiveTimeZone: z.string(),
  /** The language of cards and bot replies; null: the Organization's. */
  language: ChatLanguage.nullable(),
  /** The language cards and bot replies are in: the person's own, or the Organization's. */
  effectiveLanguage: ChatLanguage,
});
export type ChatPreferencesView = z.infer<typeof ChatPreferencesView>;

export const ChatAccountView = z.object({
  provider: ChatProvider,
  /** As the chat app reported it, when it does. */
  displayName: z.string().nullable(),
  linkedAt: Timestamp,
});
export type ChatAccountView = z.infer<typeof ChatAccountView>;

/** `GET /me/chat-apps`: the chat apps an Admin turned on, my linked accounts and preferences. */
export const MyChatAppsView = z.object({
  apps: z.array(
    z.object({
      provider: ChatProvider,
      enabled: z.boolean(),
      account: ChatAccountView.nullable(),
    }),
  ),
  preferences: ChatPreferencesView,
});
export type MyChatAppsView = z.infer<typeof MyChatAppsView>;

/**
 * `POST /me/chat-apps/:provider/link-code`: a one-time code to send to the bot. Shown
 * once (only its hash is stored); a new code replaces any earlier unused one.
 */
export const ChatLinkCodeView = z.object({
  provider: ChatProvider,
  code: z.string(),
  expiresAt: Timestamp,
});
export type ChatLinkCodeView = z.infer<typeof ChatLinkCodeView>;

/** `chatAccount.changed`: a chat account of the person was linked or unlinked. */
export const ChatAccountChangedEvent = z.object({ provider: ChatProvider, linked: z.boolean() });
export type ChatAccountChangedEvent = z.infer<typeof ChatAccountChangedEvent>;
