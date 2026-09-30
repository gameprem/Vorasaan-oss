import { z } from 'zod';
import { TeamRole } from './enums.ts';

export const FeatureSummaryView = z.object({
  id: z.uuid(),
  title: z.string(),
  teamId: z.uuid(),
  teamName: z.string(),
  projectName: z.string(),
  /** The Team Roles the current user owns on this Feature. */
  myRoles: z.array(TeamRole),
});
export type FeatureSummaryView = z.infer<typeof FeatureSummaryView>;
