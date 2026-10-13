import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  BUILT_IN_PLATFORMS,
  type PlatformDefinition,
  PlatformDesignTemplate,
  type PlatformRef,
  type PlatformsInUse,
  type PlatformTemplateInput,
  type PlatformTemplateView,
  type PlatformView,
  type ProjectPlatformsInput,
  type ProjectPlatformsView,
  type SetFeaturePlatformsInput,
  type SpecTemplateView,
  specTemplate,
} from '@vorasaan/shared';
import { featureInOrganizationOf } from '../auth/organization-scope.ts';
import { assertCanEditProject, projectAccess } from '../brief/brief-access.ts';
import { SpecChanges } from '../design-docs/spec-changes.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

type Db = PrismaClient | Prisma.TransactionClient;

const ordered = [
  { position: 'asc' },
  { id: 'asc' },
] satisfies Prisma.PlatformOrderByWithRelationInput[];

/**
 * Platforms (ADR 0009, ticket 0050): each Project's own ordered list, copied from the
 * Organization's default when the Project is created, and the Platforms each Feature
 * targets. Lists are replaced whole and atomically. Changing a Project's list locks its row
 * (FOR UPDATE) and targeting takes it FOR SHARE, so a Platform can't be removed while a
 * Feature is being pointed at it.
 */
@Injectable()
export class PlatformsService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly specChanges: SpecChanges,
  ) {}

  // ─── A Project's list (everyone reads; Admins and the Project's POs edit) ─

  async forProject(user: User, projectId: string): Promise<ProjectPlatformsView> {
    const { canEdit } = await projectAccess(this.db, user, projectId);
    return { projectId, canEdit, platforms: await this.list(this.db, projectId) };
  }

  /**
   * Replaces the Project's list. Platforms sent with an `id` are updated in place, so the
   * Features that target them keep doing so; those left out are removed, which is refused
   * (409, naming the Features) while any Feature targets them.
   */
  async replaceForProject(
    user: User,
    projectId: string,
    input: ProjectPlatformsInput,
  ): Promise<ProjectPlatformsView> {
    await assertCanEditProject(this.db, user, projectId);
    const keptIds = input.platforms.flatMap((p) => (p.id ? [p.id] : []));
    if (new Set(keptIds).size !== keptIds.length) {
      throw new UnprocessableEntityException('A Platform appears twice in the list');
    }

    const platforms = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
      const existing = await tx.platform.findMany({
        where: { projectId },
        select: { id: true, name: true },
      });
      const byId = new Map(existing.map((p) => [p.id, p]));
      const unknown = keptIds.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        throw new UnprocessableEntityException(
          `Not a Platform of this Project: ${unknown.join(', ')}`,
        );
      }

      const kept = new Set(keptIds);
      const removed = existing.filter((p) => !kept.has(p.id));
      if (removed.length > 0) {
        const targets = await tx.featurePlatform.findMany({
          where: { platformId: { in: removed.map((p) => p.id) } },
          select: {
            platform: { select: { id: true, name: true } },
            feature: { select: { id: true, title: true } },
          },
          orderBy: [{ platform: { position: 'asc' } }, { feature: { title: 'asc' } }],
        });
        if (targets.length > 0) throw platformsInUse(targets);
        await tx.platform.deleteMany({ where: { id: { in: removed.map((p) => p.id) } } });
      }

      // Renames go through a temporary name first, so swapping two names doesn't trip the
      // case-insensitive unique index halfway.
      const renamed = input.platforms.filter(
        (p) => p.id && byId.get(p.id)?.name.toLowerCase() !== p.name.toLowerCase(),
      );
      for (const p of renamed) {
        await tx.platform.update({ where: { id: p.id }, data: { name: `~renaming~${p.id}` } });
      }
      for (const [position, { id, ...definition }] of input.platforms.entries()) {
        const data = { ...definitionData(definition), position };
        if (id) await tx.platform.update({ where: { id }, data });
        else await tx.platform.create({ data: { projectId, ...data } });
      }
      return this.list(tx, projectId);
    });
    // A Platform's Team Roles or checks may have completed (or broken) Features' Coverage,
    // so Design Docs may be due (ticket 0069).
    const targeting = await this.db.featurePlatform.findMany({
      where: { platform: { projectId } },
      distinct: ['featureId'],
      select: { featureId: true },
    });
    for (const { featureId } of targeting) this.specChanges.changed(featureId);
    const { canEdit } = await projectAccess(this.db, user, projectId);
    return { projectId, canEdit, platforms };
  }

  /** Copies the Organization's default into a new Project (inside its creating transaction). */
  async copyTemplate(tx: Db, organizationId: string, projectId: string): Promise<void> {
    const template = await this.template(tx, organizationId);
    await tx.platform.createMany({
      data: template.platforms.map((p, position) => ({
        projectId,
        position,
        ...definitionData(p),
      })),
    });
  }

  private list(db: Db, projectId: string): Promise<PlatformView[]> {
    return db.platform
      .findMany({ where: { projectId }, orderBy: ordered })
      .then((rows) => rows.map((p) => ({ id: p.id, position: p.position, ...definitionData(p) })));
  }

  // ─── The Organization's default (every member reads; Admins replace) ──────

  async getTemplate(user: User): Promise<PlatformTemplateView> {
    const organizationId = await this.memberOrganizationId(user);
    return this.template(this.db, organizationId);
  }

  /** Replaces the default list. Existing Projects keep the Platforms they have. */
  async replaceTemplate(user: User, input: PlatformTemplateInput): Promise<PlatformTemplateView> {
    const organizationId = await this.adminOrganizationId(user);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
      await tx.orgPlatformTemplate.deleteMany({ where: { organizationId } });
      await tx.orgPlatformTemplate.createMany({
        data: input.platforms.map((p, position) => ({
          organizationId,
          position,
          ...definitionData(p),
        })),
      });
      return this.template(tx, organizationId);
    });
  }

  private async template(db: Db, organizationId: string): Promise<PlatformTemplateView> {
    const rows = await db.orgPlatformTemplate.findMany({
      where: { organizationId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return rows.length === 0
      ? { organizationId, builtIn: true, platforms: BUILT_IN_PLATFORMS.map(definitionData) }
      : { organizationId, builtIn: false, platforms: rows.map(definitionData) };
  }

  // ─── A Feature's target Platforms ─────────────────────────────────────────

  /** Admins and the Team's POs choose the Platforms a Feature targets. */
  async setFeatureTargets(
    user: User,
    featureId: string,
    { platformIds }: SetFeaturePlatformsInput,
  ): Promise<PlatformRef[]> {
    const feature = await this.db.feature.findFirst({
      where: { id: featureId, ...featureInOrganizationOf(user.id) },
      select: { teamId: true, team: { select: { projectId: true } } },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    await this.assertCanManageTeam(user, feature.teamId);
    const { projectId } = feature.team;
    const targets = await this.db.$transaction(async (tx) => {
      await this.assertTargetable(tx, projectId, platformIds);
      await tx.featurePlatform.deleteMany({
        where: { featureId, platformId: { notIn: platformIds } },
      });
      await tx.featurePlatform.createMany({
        data: platformIds.map((platformId) => ({ featureId, platformId })),
        skipDuplicates: true,
      });
      return this.targets(tx, featureId);
    });
    // New targets may have Design Docs due; QA's covers every target (ticket 0069).
    this.specChanges.changed(featureId);
    return targets;
  }

  /**
   * Inside a transaction: every id is a Platform of the Project. Locks the Project's row
   * FOR SHARE, so the list can't lose one of them before the transaction commits.
   */
  async assertTargetable(tx: Db, projectId: string, platformIds: string[]): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "Project" WHERE id = ${projectId} FOR SHARE`;
    if (platformIds.length === 0) return;
    const found = await tx.platform.findMany({
      where: { projectId, id: { in: platformIds } },
      select: { id: true },
    });
    const ours = new Set(found.map((p) => p.id));
    const foreign = platformIds.filter((id) => !ours.has(id));
    if (foreign.length > 0) {
      throw new UnprocessableEntityException(
        `A Feature can only target its own Project's Platforms: ${foreign.join(', ')}`,
      );
    }
  }

  /** The Platforms a Feature targets, in its Project's order. */
  async targets(db: Db, featureId: string): Promise<PlatformRef[]> {
    const rows = await db.platform.findMany({
      where: { features: { some: { featureId } } },
      orderBy: ordered,
      select: { id: true, name: true },
    });
    return rows;
  }

  /** What the Feature's first Spec starts from: one section per target Platform. */
  async specTemplate(user: User, featureId: string): Promise<SpecTemplateView> {
    const feature = await this.db.feature.findFirst({
      where: { id: featureId, ...featureInOrganizationOf(user.id) },
      select: { title: true },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    const platforms = await this.targets(this.db, featureId);
    return {
      markdown: specTemplate({ title: feature.title, platforms: platforms.map((p) => p.name) }),
    };
  }

  // ─── Permissions ──────────────────────────────────────────────────────────

  private async assertCanManageTeam(user: User, teamId: string) {
    const [admin, po] = await Promise.all([
      this.db.orgMembership.count({ where: { userId: user.id, role: 'ADMIN' } }),
      this.db.teamMembership.count({ where: { teamId, userId: user.id, role: 'PO' } }),
    ]);
    if (admin + po === 0) {
      throw new ForbiddenException("Only an Admin or this Team's PO can do this");
    }
  }

  private async memberOrganizationId(user: User): Promise<string> {
    const membership = await this.db.orgMembership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    if (!membership) throw new ForbiddenException('You are not in an Organization');
    return membership.organizationId;
  }

  private async adminOrganizationId(user: User): Promise<string> {
    const admin = await this.db.orgMembership.findFirst({
      where: { userId: user.id, role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    if (!admin) throw new ForbiddenException('Only an Organization Admin can do this');
    return admin.organizationId;
  }
}

function definitionData(
  p: Omit<PlatformDefinition, 'designTemplate'> & { designTemplate?: string | null },
): PlatformDefinition {
  // QA is never a Platform's template (the contract refuses it); anything else reads as unset.
  const template = PlatformDesignTemplate.safeParse(p.designTemplate);
  return {
    name: p.name,
    roles: p.roles ?? [],
    specSection: p.specSection,
    someoneToAsk: p.someoneToAsk,
    noOpenBlockers: p.noOpenBlockers,
    qaReady: p.qaReady,
    designTemplate: template.success ? template.data : null,
  };
}

function platformsInUse(
  targets: { platform: { id: string; name: string }; feature: { id: string; title: string } }[],
): ConflictException {
  const names = [...new Set(targets.map((t) => t.platform.name))];
  const titles = [...new Set(targets.map((t) => `"${t.feature.title}"`))];
  const body: PlatformsInUse = {
    statusCode: 409,
    error: 'Conflict',
    message: `${names.join(', ')} can't be removed while Features target ${
      names.length === 1 ? 'it' : 'them'
    }: ${titles.join(', ')}. Change those Features' Platforms first.`,
    features: targets.map((t) => ({
      id: t.feature.id,
      title: t.feature.title,
      platformId: t.platform.id,
      platformName: t.platform.name,
    })),
  };
  return new ConflictException(body);
}
