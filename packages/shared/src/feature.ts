import { z } from 'zod';
import { JiraIssueKey } from './atlassian.ts';
import { TeamRole } from './enums.ts';
import { PlatformRef } from './platform.ts';

export const FeatureSummaryView = z.object({
  id: z.uuid(),
  title: z.string(),
  teamId: z.uuid(),
  teamName: z.string(),
  /** The Project the Feature's Team belongs to (the CLI scopes to a repo's bound Project). */
  projectId: z.uuid(),
  projectName: z.string(),
  /** The Team Roles the current user owns on this Feature. */
  myRoles: z.array(TeamRole),
});
export type FeatureSummaryView = z.infer<typeof FeatureSummaryView>;

/** `GET /features/:id`. */
export const FeatureView = FeatureSummaryView.extend({
  /** The linked Jira Epic, if any. */
  jiraIssueKey: z.string().nullable(),
  /** The Epic on the Atlassian site; null when unlinked or Atlassian isn't connected. */
  jiraIssueUrl: z.string().nullable(),
  /** Blockers on this Feature that are OPEN or NEEDS_INFO; the Feature is Blocked while > 0. */
  openBlockers: z.int().nonnegative(),
  /** The Platforms it targets (ADR 0009), in its Project's order. */
  platforms: z.array(PlatformRef),
});
export type FeatureView = z.infer<typeof FeatureView>;

/** `PATCH /features/:id`: `jiraIssueKey` null or "" unlinks the Jira Epic. */
export const UpdateFeatureInput = z.object({
  jiraIssueKey: JiraIssueKey.nullable().or(z.literal('').transform(() => null)),
});
export type UpdateFeatureInput = z.infer<typeof UpdateFeatureInput>;
