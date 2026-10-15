import type { ChatLanguage } from './chat-apps.ts';
import type { ChatEventKind, ChatProvider } from './enums.ts';

// Plain values of chat-apps.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

export const CHAT_PROVIDER_LABEL: Record<ChatProvider, string> = {
  LINE: 'LINE',
  SLACK: 'Slack',
  TEAMS: 'Microsoft Teams',
};

export const CHAT_EVENT_LABEL: Record<ChatEventKind, string> = {
  DECISION_REQUEST: 'Decision Requests sent to me',
  NEEDS_INFO: 'Requests for more info on my Decision Requests (NEEDS_INFO)',
  SPEC_PROPOSAL: 'Spec Proposals to approve (a link to Vorasaan)',
  ESCALATION: 'Response Window reminders and overdue notices',
};

/** The languages of cards and bot replies (`ChatLanguage`). */
export const CHAT_LANGUAGES = ['en', 'th'] as const;

export const CHAT_LANGUAGE_LABEL: Record<ChatLanguage, string> = {
  en: 'English',
  th: 'ไทย (Thai)',
};
