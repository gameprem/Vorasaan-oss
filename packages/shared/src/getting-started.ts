import { z } from 'zod';
import { ChatLanguage } from './chat-apps.ts';

// After first-run setup (ticket 0063): the Organization's default language, and the
// Getting started checklist that leads the first Admin to a working team.

/** `GET /settings/organization` (every member): the Organization's name and language. */
export const OrganizationSettingsView = z.object({
  name: z.string(),
  /** The language of chat app cards and bot replies for anyone who hasn't picked their own. */
  language: ChatLanguage,
});
export type OrganizationSettingsView = z.infer<typeof OrganizationSettingsView>;

/** `PUT /settings/organization` (Admins). */
export const OrganizationSettingsInput = z.strictObject({ language: ChatLanguage });
export type OrganizationSettingsInput = z.infer<typeof OrganizationSettingsInput>;

/**
 * The checklist's items, in order. Each ticks itself from what exists:
 * - PROJECT_AND_TEAM: a Project with a Team.
 * - FEATURE_WITH_SPEC: a Feature with a Spec Version.
 * - INVITE_MEMBERS: someone besides the first Admin has joined (an accepted invitation).
 * - LINK_CLI: the viewer's own Access token (Personal Access Token) has been used.
 * - CHAT_APP (optional): an Admin turned on LINE, Slack or Teams.
 */
export const GettingStartedItemKey = z.enum([
  'PROJECT_AND_TEAM',
  'FEATURE_WITH_SPEC',
  'INVITE_MEMBERS',
  'LINK_CLI',
  'CHAT_APP',
]);
export type GettingStartedItemKey = z.infer<typeof GettingStartedItemKey>;

export const GettingStartedItem = z.object({
  key: GettingStartedItemKey,
  done: z.boolean(),
  /** Not needed for the checklist to be complete. */
  optional: z.boolean(),
});
export type GettingStartedItem = z.infer<typeof GettingStartedItem>;

/** `GET /me/getting-started` (Admins): the checklist as the database has it now. */
export const GettingStartedView = z.object({
  items: z.array(GettingStartedItem),
  /** Every item that isn't optional is done: the checklist is no longer shown. */
  complete: z.boolean(),
  /** The viewer dismissed it: no longer shown to them. */
  dismissed: z.boolean(),
});
export type GettingStartedView = z.infer<typeof GettingStartedView>;

export const GETTING_STARTED_LABEL: Record<GettingStartedItemKey, string> = {
  PROJECT_AND_TEAM: 'Create a Project and a Team',
  FEATURE_WITH_SPEC: 'Create a Feature and write its Spec',
  INVITE_MEMBERS: 'Invite members',
  LINK_CLI: 'Link the CLI (vorasaan login)',
  CHAT_APP: 'Connect a chat app (LINE, Slack or Teams)',
};
