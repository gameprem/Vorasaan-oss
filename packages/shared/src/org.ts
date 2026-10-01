import { z } from 'zod';
import { JiraIssueKey } from './atlassian.ts';
import { Password } from './auth.ts';
import { OrgRole, TeamRole } from './enums.ts';

const Name = z.string().trim().min(1, 'Enter a name').max(100);

// ─── Projects & Teams ───────────────────────────────────────────────────────

export const CreateProjectInput = z.object({
  name: Name,
  jiraKey: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Jira keys look like MB or PAY2')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type CreateProjectInput = z.input<typeof CreateProjectInput>;

export const CreateTeamInput = z.object({ name: Name });
export type CreateTeamInput = z.infer<typeof CreateTeamInput>;

export const TeamSummary = z.object({ id: z.uuid(), name: z.string(), featureCount: z.int() });
export const ProjectView = z.object({
  id: z.uuid(),
  name: z.string(),
  jiraKey: z.string().nullable(),
  teams: z.array(TeamSummary),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const TeamMemberView = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  roles: z.array(TeamRole),
});
export type TeamMemberView = z.infer<typeof TeamMemberView>;

export const TeamView = z.object({
  id: z.uuid(),
  name: z.string(),
  project: z.object({ id: z.uuid(), name: z.string() }),
  members: z.array(TeamMemberView),
  features: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      status: z.string(),
      /** Blockers that are OPEN or NEEDS_INFO; the Feature is Blocked while > 0. */
      openBlockers: z.int().nonnegative(),
      /** The latest Spec Version's number; 0 while the Feature has no Spec. */
      specVersion: z.int().nonnegative(),
    }),
  ),
  /** Whether the current user may manage members and Features here. */
  canManage: z.boolean(),
});
export type TeamView = z.infer<typeof TeamView>;

/** `GET /me/teams`: one of the signed-in user's Teams, with everyone's Team Roles in it. */
export const MyTeamView = z.object({
  id: z.uuid(),
  name: z.string(),
  project: z.object({ id: z.uuid(), name: z.string() }),
  /** The signed-in user's own Team Roles in this Team. */
  myRoles: z.array(TeamRole),
  members: z.array(TeamMemberView),
});
export type MyTeamView = z.infer<typeof MyTeamView>;

/** Replaces a member's Team Roles; an empty list removes them from the Team. */
export const SetTeamRolesInput = z.object({ roles: z.array(TeamRole) });
export type SetTeamRolesInput = z.infer<typeof SetTeamRolesInput>;

// ─── Members & invitations ──────────────────────────────────────────────────

export const OrgMemberView = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: OrgRole,
});
export type OrgMemberView = z.infer<typeof OrgMemberView>;

export const CreateInvitationInput = z.object({
  email: z.email({ message: 'Enter a valid email' }),
  role: OrgRole.default('MEMBER'),
});
export type CreateInvitationInput = z.input<typeof CreateInvitationInput>;

export const InvitationView = z.object({
  id: z.uuid(),
  email: z.string(),
  role: OrgRole,
  expiresAt: z.iso.datetime(),
});
export type InvitationView = z.infer<typeof InvitationView>;

/** Returned once: the secret part of the invite link. */
export const CreatedInvitation = InvitationView.extend({ token: z.string() });
export type CreatedInvitation = z.infer<typeof CreatedInvitation>;

export const InvitationPreview = z.object({ organizationName: z.string(), email: z.string() });
export type InvitationPreview = z.infer<typeof InvitationPreview>;

export const AcceptInvitationInput = z.object({ name: Name, password: Password });
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationInput>;

// ─── Features & Spec ────────────────────────────────────────────────────────

export const CreateFeatureInput = z.object({
  title: z.string().trim().min(1, 'Give the Feature a title').max(200),
  description: z.string().trim().max(2000).optional(),
  jiraIssueKey: JiraIssueKey.optional().or(z.literal('').transform(() => undefined)),
});
export type CreateFeatureInput = z.input<typeof CreateFeatureInput>;

export const RoleOwnerView = z.object({ userId: z.uuid(), name: z.string(), role: TeamRole });
export type RoleOwnerView = z.infer<typeof RoleOwnerView>;

export const SetRoleOwnersInput = z.object({
  owners: z.array(z.object({ userId: z.uuid(), role: TeamRole })),
});
export type SetRoleOwnersInput = z.infer<typeof SetRoleOwnersInput>;

/** A hand-written Spec Version. `baseVersion` guards against overwriting a newer one. */
export const WriteSpecInput = z.object({
  markdown: z.string().trim().min(1, 'The Spec is empty'),
  summary: z.string().trim().max(200).optional(),
  baseVersion: z.int().nonnegative(),
});
export type WriteSpecInput = z.infer<typeof WriteSpecInput>;
