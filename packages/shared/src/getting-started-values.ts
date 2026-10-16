import type { GettingStartedItemKey } from './getting-started.ts';

// Plain values of getting-started.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

export const GETTING_STARTED_LABEL: Record<GettingStartedItemKey, string> = {
  PROJECT_AND_TEAM: 'Create a Project and a Team',
  FEATURE_WITH_SPEC: 'Create a Feature and write its Spec',
  INVITE_MEMBERS: 'Invite members',
  LINK_CLI: 'Link the CLI (vorasaan login)',
  CHAT_APP: 'Connect a chat app (LINE, Slack or Teams)',
};
