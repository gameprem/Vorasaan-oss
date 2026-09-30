import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import type {
  AcceptInvitationInput,
  CreatedInvitation,
  CreateFeatureInput,
  CreateInvitationInput,
  CreateProjectInput,
  InvitationPreview,
  InvitationView,
  LoginResult,
  OrgMemberView,
  ProjectView,
  RoleOwnerView,
  SetRoleOwnersInput,
  SetTeamRolesInput,
  SpecVersionView,
  TeamRole,
  TeamView,
  WriteSpecInput,
} from '@vorasaan/shared';
import { AuthService, hashPassword } from '../auth/auth.service.ts';
import { hashToken, newToken } from '../auth/tokens.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { normalizeMarkdown } from '../spec/markdown.ts';
import { specVersionInclude, toSpecVersionView } from '../spec/spec.view.ts';
import { assertCanEditSpec } from '../spec/spec-access.ts';

const INVITE_PREFIX = 'vsi_';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Organization structure: Projects, Teams, members, Features, Role Owners and
 * hand-written Spec Versions. Admins manage everything; a Team's PO can manage
 * that Team's members and Features.
 */
@Injectable()
export class OrgService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly auth: AuthService,
  ) {}

  // ─── Permissions ──────────────────────────────────────────────────────────

  private async organizationId(): Promise<string> {
    const org = await this.db.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!org) throw new UnprocessableEntityException('Run setup first');
    return org.id;
  }

  async isAdmin(userId: string) {
    return (await this.db.orgMembership.count({ where: { userId, role: 'ADMIN' } })) > 0;
  }

  private async canManageTeam(userId: string, teamId: string) {
    if (await this.isAdmin(userId)) return true;
    return (await this.db.teamMembership.count({ where: { teamId, userId, role: 'PO' } })) > 0;
  }

  private async assertCanManageTeam(user: User, teamId: string) {
    if (!(await this.canManageTeam(user.id, teamId))) {
      throw new ForbiddenException("Only an Admin or this Team's PO can do this");
    }
  }

  private async teamOfFeature(featureId: string) {
    const feature = await this.db.feature.findUnique({
      where: { id: featureId },
      select: { teamId: true },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    return feature.teamId;
  }

  // ─── Projects & Teams ─────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectView[]> {
    const projects = await this.db.project.findMany({
      orderBy: { name: 'asc' },
      include: {
        teams: {
          orderBy: { name: 'asc' },
          include: { _count: { select: { features: true } } },
        },
      },
    });
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      jiraKey: p.jiraKey,
      teams: p.teams.map((t) => ({ id: t.id, name: t.name, featureCount: t._count.features })),
    }));
  }

  async createProject(input: CreateProjectInput) {
    const organizationId = await this.organizationId();
    try {
      return await this.db.project.create({
        data: { organizationId, name: input.name, jiraKey: input.jiraKey ?? null },
      });
    } catch (error) {
      throw uniqueConflict(error, 'A Project with that name or Jira key already exists');
    }
  }

  async createTeam(projectId: string, name: string) {
    if (!(await this.db.project.count({ where: { id: projectId } }))) {
      throw new NotFoundException('Project not found');
    }
    try {
      return await this.db.team.create({ data: { projectId, name } });
    } catch (error) {
      throw uniqueConflict(error, 'This Project already has a Team with that name');
    }
  }

  async getTeam(user: User, teamId: string): Promise<TeamView> {
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      include: {
        project: { select: { id: true, name: true } },
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        },
        features: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, title: true, status: true },
        },
      },
    });
    if (!team) throw new NotFoundException('Team not found');

    const byUser = new Map<string, TeamView['members'][number]>();
    for (const m of team.members) {
      const entry = byUser.get(m.userId) ?? {
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        roles: [],
      };
      entry.roles.push(m.role);
      byUser.set(m.userId, entry);
    }
    return {
      id: team.id,
      name: team.name,
      project: team.project,
      members: [...byUser.values()],
      features: team.features,
      canManage: await this.canManageTeam(user.id, teamId),
    };
  }

  async setTeamRoles(user: User, teamId: string, userId: string, input: SetTeamRolesInput) {
    await this.assertCanManageTeam(user, teamId);
    if (!(await this.db.orgMembership.count({ where: { userId } }))) {
      throw new NotFoundException('That person is not a member of this Organization');
    }
    const roles = [...new Set(input.roles)];
    await this.db.$transaction([
      this.db.teamMembership.deleteMany({ where: { teamId, userId, role: { notIn: roles } } }),
      ...roles.map((role) =>
        this.db.teamMembership.upsert({
          where: { teamId_userId_role: { teamId, userId, role } },
          update: {},
          create: { teamId, userId, role },
        }),
      ),
    ]);
    return this.getTeam(user, teamId);
  }

  // ─── Members & invitations ────────────────────────────────────────────────

  async listMembers(): Promise<OrgMemberView[]> {
    const members = await this.db.orgMembership.findMany({
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { user: { name: 'asc' } },
    });
    return members.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
    }));
  }

  async createInvitation(user: User, input: CreateInvitationInput): Promise<CreatedInvitation> {
    const organizationId = await this.organizationId();
    const email = input.email.toLowerCase();
    if (await this.db.user.count({ where: { email } })) {
      throw new ConflictException('Someone with that email is already a member');
    }
    const token = newToken(INVITE_PREFIX);
    const invitation = await this.db.invitation.create({
      data: {
        organizationId,
        email,
        role: input.role ?? 'MEMBER',
        tokenHash: hashToken(token),
        invitedById: user.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    return { ...toInvitationView(invitation), token };
  }

  async listInvitations(): Promise<InvitationView[]> {
    const invitations = await this.db.invitation.findMany({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return invitations.map(toInvitationView);
  }

  async revokeInvitation(id: string) {
    const { count } = await this.db.invitation.deleteMany({ where: { id, acceptedAt: null } });
    if (!count) throw new NotFoundException('Invitation not found');
  }

  private async openInvitation(token: string) {
    const invitation = await this.db.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { organization: { select: { name: true } } },
    });
    if (!invitation) throw new NotFoundException('This invite link is not valid');
    if (invitation.acceptedAt)
      throw new GoneException('This invite was already used. Sign in instead.');
    if (invitation.expiresAt <= new Date()) {
      throw new GoneException('This invite link expired. Ask your Admin for a new one.');
    }
    return invitation;
  }

  async previewInvitation(token: string): Promise<InvitationPreview> {
    const invitation = await this.openInvitation(token);
    return { organizationName: invitation.organization.name, email: invitation.email };
  }

  async acceptInvitation(token: string, input: AcceptInvitationInput): Promise<LoginResult> {
    const invitation = await this.openInvitation(token);
    const passwordHash = await hashPassword(input.password);
    const user = await this.db.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new GoneException('This invite was already used');
      const user = await tx.user.create({
        data: { email: invitation.email, name: input.name, passwordHash },
      });
      await tx.orgMembership.create({
        data: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role },
      });
      return user;
    });
    return this.auth.startSession(user);
  }

  // ─── Features, Role Owners, Spec ──────────────────────────────────────────

  async createFeature(user: User, teamId: string, input: CreateFeatureInput) {
    if (!(await this.db.team.count({ where: { id: teamId } }))) {
      throw new NotFoundException('Team not found');
    }
    await this.assertCanManageTeam(user, teamId);
    return this.db.feature.create({
      data: {
        teamId,
        title: input.title,
        description: input.description || null,
        jiraIssueKey: input.jiraIssueKey ?? null,
        status: 'IN_PROGRESS',
      },
      select: { id: true, title: true },
    });
  }

  async listRoleOwners(featureId: string): Promise<RoleOwnerView[]> {
    await this.teamOfFeature(featureId);
    const owners = await this.db.roleOwner.findMany({
      where: { featureId },
      include: { user: { select: { name: true } } },
      orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }],
    });
    return owners.map((o) => ({ userId: o.userId, name: o.user.name, role: o.role }));
  }

  /** Role Owners must hold that Team Role in the Feature's Team. */
  async setRoleOwners(user: User, featureId: string, input: SetRoleOwnersInput) {
    const teamId = await this.teamOfFeature(featureId);
    await this.assertCanManageTeam(user, teamId);

    const unique = [...new Map(input.owners.map((o) => [`${o.userId}:${o.role}`, o])).values()];
    const memberships = await this.db.teamMembership.findMany({
      where: { teamId, OR: unique.map((o) => ({ userId: o.userId, role: o.role })) },
      select: { userId: true, role: true },
    });
    const held = new Set(memberships.map((m) => `${m.userId}:${m.role}`));
    const missing = unique.filter((o) => !held.has(`${o.userId}:${o.role}`));
    if (missing.length) {
      throw new UnprocessableEntityException(
        'Everyone must hold the Team Role in this Team before owning it on a Feature',
      );
    }

    await this.db.$transaction([
      this.db.roleOwner.deleteMany({ where: { featureId } }),
      this.db.roleOwner.createMany({
        data: unique.map((o) => ({ featureId, userId: o.userId, role: o.role as TeamRole })),
      }),
    ]);
    return this.listRoleOwners(featureId);
  }

  /** Admins and the Feature's PO Role Owners write the Spec by hand. */
  async writeSpec(user: User, featureId: string, input: WriteSpecInput): Promise<SpecVersionView> {
    await this.teamOfFeature(featureId);
    await assertCanEditSpec(this.db, user, featureId);

    try {
      const version = await this.db.$transaction(async (tx) => {
        const latest = await tx.specVersion.findFirst({
          where: { featureId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const current = latest?.version ?? 0;
        if (current !== input.baseVersion) {
          throw new ConflictException(
            `The Spec is now at v${current}. Reload to see the latest before saving.`,
          );
        }
        return tx.specVersion.create({
          data: {
            featureId,
            version: current + 1,
            markdown: normalizeMarkdown(input.markdown),
            source: 'MANUAL',
            summary: input.summary || (current === 0 ? 'Initial Spec' : 'Edited by hand'),
            approvedById: user.id,
          },
          include: specVersionInclude,
        });
      });
      return toSpecVersionView(version);
    } catch (error) {
      throw uniqueConflict(error, 'Someone saved the Spec at the same time. Reload and try again.');
    }
  }
}

function toInvitationView(i: {
  id: string;
  email: string;
  role: 'ADMIN' | 'MEMBER';
  expiresAt: Date;
}): InvitationView {
  return { id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() };
}

/** Maps Prisma's unique-constraint error (P2002) to a 409; rethrows anything else. */
function uniqueConflict(error: unknown, message: string): unknown {
  if ((error as { code?: string })?.code === 'P2002') return new ConflictException(message);
  return error;
}
