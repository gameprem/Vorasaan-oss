import { z } from 'zod';

/** Jira issue keys look like MB-42 (project key, dash, number). */
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** A Jira issue key, upper-cased, e.g. "mb-42" → "MB-42". */
export const JiraIssueKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(JIRA_ISSUE_KEY, 'Jira issue keys look like MB-42');

/**
 * `PUT /settings/atlassian` (Admins): the Organization's Atlassian Cloud site,
 * read by Confluence and Jira Attachments. `apiToken` may be omitted when
 * updating: the stored token is kept, unless the site changes host.
 */
export const AtlassianSettingsInput = z.object({
  siteUrl: z.url({
    protocol: /^https?$/,
    message: 'Enter the site URL, e.g. https://acme.atlassian.net',
  }),
  email: z.email('Enter the email of the Atlassian account that owns the API token'),
  apiToken: z.string().trim().min(1, 'Enter an API token').optional(),
});
export type AtlassianSettingsInput = z.infer<typeof AtlassianSettingsInput>;

/** The API token is never returned, only whether one is stored. */
export const AtlassianSettingsView = z.object({
  configured: z.boolean(),
  siteUrl: z.string().nullable(),
  email: z.string().nullable(),
  apiTokenSet: z.boolean(),
});
export type AtlassianSettingsView = z.infer<typeof AtlassianSettingsView>;

export const AtlassianTestResult = z.object({ ok: z.boolean(), message: z.string() });
export type AtlassianTestResult = z.infer<typeof AtlassianTestResult>;
