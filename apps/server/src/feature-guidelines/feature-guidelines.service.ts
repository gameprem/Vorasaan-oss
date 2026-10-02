import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { GuidelineCriterion, Prisma, PrismaClient, User } from '@vorasaan/db';
import type {
  EffectiveFeatureGuidelinesView,
  EffectiveGuidelineCriterion,
  GuidelineCriterionText,
  GuidelineCriterionView,
  OrgFeatureGuidelinesInput,
  OrgFeatureGuidelinesView,
  ProjectFeatureGuidelinesInput,
  ProjectFeatureGuidelinesView,
  ProjectGuidelineOverrideView,
} from '@vorasaan/shared';
import { assertCanEditProject, projectAccess } from '../brief/brief-access.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const ordered = [
  { position: 'asc' },
  { id: 'asc' },
] satisfies Prisma.GuidelineCriterionOrderByWithRelationInput[];

/**
 * The Feature Guidelines (ADR 0006, REQUIREMENT §3.8): an ordered Organization
 * default, and per Project a list of overrides that add a criterion, edit a
 * default one's text or hide it. Both lists are replaced whole and atomically;
 * `effective` merges them for the AI workflows.
 */
@Injectable()
export class FeatureGuidelinesService {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  // ─── Organization default (everyone reads, Admins replace) ──────────────

  /**
   * Readable by every member of the Organization, so a PO adjusting a Project
   * sees the text of the criteria it inherits, including ones it hides.
   */
  async getDefault(user: User): Promise<OrgFeatureGuidelinesView> {
    const organizationId = await this.memberOrganizationId(user);
    return { organizationId, criteria: await this.defaults(this.db, organizationId) };
  }

  /**
   * Replaces the default list. Criteria sent with an `id` are updated in place,
   * so Projects' overrides of them survive; those left out are deleted, and the
   * database cascades to every Project's edits and hides of them.
   */
  async replaceDefault(
    user: User,
    input: OrgFeatureGuidelinesInput,
  ): Promise<OrgFeatureGuidelinesView> {
    const organizationId = await this.adminOrganizationId(user);
    const keptIds = input.criteria.flatMap((c) => (c.id ? [c.id] : []));
    if (new Set(keptIds).size !== keptIds.length) {
      throw new UnprocessableEntityException('A criterion appears twice in the list');
    }
    const criteria = await this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      const existing = await tx.guidelineCriterion.findMany({
        where: { organizationId, projectId: null },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((c) => c.id));
      const unknown = keptIds.filter((id) => !existingIds.has(id));
      if (unknown.length > 0) {
        throw new UnprocessableEntityException(
          `Not a criterion of this Organization's Feature Guidelines: ${unknown.join(', ')}`,
        );
      }
      await tx.guidelineCriterion.deleteMany({
        where: { organizationId, projectId: null, id: { notIn: keptIds } },
      });
      for (const [position, { id, ...text }] of input.criteria.entries()) {
        const data = { ...criterionText(text), position };
        if (id) await tx.guidelineCriterion.update({ where: { id }, data });
        else await tx.guidelineCriterion.create({ data: { organizationId, ...data } });
      }
      return this.defaults(tx, organizationId);
    });
    return { organizationId, criteria };
  }

  // ─── Project overrides (Admins and the Project's POs) ──────────────────

  async getOverrides(user: User, projectId: string): Promise<ProjectFeatureGuidelinesView> {
    await assertCanEditProject(this.db, user, projectId);
    return { projectId, overrides: await this.overrides(this.db, projectId) };
  }

  /**
   * Replaces all of the Project's overrides. Every `overridesId` must be a
   * default criterion of the Project's own Organization, at most once.
   */
  async replaceOverrides(
    user: User,
    projectId: string,
    input: ProjectFeatureGuidelinesInput,
  ): Promise<ProjectFeatureGuidelinesView> {
    const { organizationId } = await assertCanEditProject(this.db, user, projectId);
    const refs = input.overrides.flatMap((o) => (o.action === 'ADD' ? [] : [o.overridesId]));
    if (new Set(refs).size !== refs.length) {
      throw new UnprocessableEntityException(
        'A default criterion can be edited or disabled only once per Project',
      );
    }
    const overrides = await this.db.$transaction(async (tx) => {
      // Serializes with a concurrent change of the default, so a reference can't vanish mid-way.
      await lockOrganization(tx, organizationId);
      const defaults = await tx.guidelineCriterion.findMany({
        where: { organizationId, projectId: null, id: { in: refs } },
      });
      const byId = new Map(defaults.map((d) => [d.id, d]));
      const unknown = refs.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        throw new UnprocessableEntityException(
          `Not a criterion of this Organization's Feature Guidelines: ${unknown.join(', ')}`,
        );
      }
      await tx.guidelineCriterion.deleteMany({ where: { projectId } });
      for (const [position, override] of input.overrides.entries()) {
        const base = { organizationId, projectId, position };
        if (override.action === 'ADD') {
          const { action: _, ...text } = override;
          await tx.guidelineCriterion.create({ data: { ...base, ...criterionText(text) } });
        } else if (override.action === 'EDIT') {
          const { action: _, overridesId, ...text } = override;
          await tx.guidelineCriterion.create({
            data: { ...base, overridesId, ...criterionText(text) },
          });
        } else {
          // Keeps a copy of the default's text, never shown.
          const hidden = byId.get(override.overridesId) as GuidelineCriterion;
          await tx.guidelineCriterion.create({
            data: {
              ...base,
              overridesId: hidden.id,
              disabled: true,
              ...criterionText(hidden),
            },
          });
        }
      }
      return this.overrides(tx, projectId);
    });
    return { projectId, overrides };
  }

  // ─── Effective (everyone in the Organization) ──────────────────────────

  async getEffective(user: User, projectId: string): Promise<EffectiveFeatureGuidelinesView> {
    await projectAccess(this.db, user, projectId);
    return { projectId, criteria: await this.effective(projectId) };
  }

  /**
   * The criteria a Feature of this Project must meet: the Organization default
   * in its order, with disabled ones left out and edited ones replaced in place,
   * then the Project's additions in their order. No permission check; callers
   * (Grilling, Feature Suggestions) have already checked access to the Project.
   */
  async effective(projectId: string): Promise<EffectiveGuidelineCriterion[]> {
    const project = await this.db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { organizationId: true },
    });
    const [defaults, overrides] = await Promise.all([
      this.db.guidelineCriterion.findMany({
        where: { organizationId: project.organizationId, projectId: null },
        orderBy: ordered,
      }),
      this.db.guidelineCriterion.findMany({ where: { projectId }, orderBy: ordered }),
    ]);
    const byDefault = new Map(
      overrides.flatMap((o) => (o.overridesId ? [[o.overridesId, o] as const] : [])),
    );
    const inherited = defaults.flatMap((d): EffectiveGuidelineCriterion[] => {
      const override = byDefault.get(d.id);
      if (!override) return [{ ...toView(d), origin: 'ORGANIZATION', overridesId: null }];
      if (override.disabled) return [];
      return [{ ...toView(override), origin: 'PROJECT_EDIT', overridesId: d.id }];
    });
    const added = overrides
      .filter((o) => !o.overridesId)
      .map(
        (o): EffectiveGuidelineCriterion => ({
          ...toView(o),
          origin: 'PROJECT',
          overridesId: null,
        }),
      );
    return [...inherited, ...added];
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** The Organization the user is a member of; 403 for someone in none. */
  private async memberOrganizationId(user: User): Promise<string> {
    const membership = await this.db.orgMembership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    if (!membership) throw new ForbiddenException('You are not in an Organization');
    return membership.organizationId;
  }

  /** The Organization the user is an Admin of; 403 for everyone else. */
  private async adminOrganizationId(user: User): Promise<string> {
    const admin = await this.db.orgMembership.findFirst({
      where: { userId: user.id, role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    if (!admin) throw new ForbiddenException('Only an Organization Admin can do this');
    return admin.organizationId;
  }

  private async defaults(db: Db, organizationId: string): Promise<GuidelineCriterionView[]> {
    const rows = await db.guidelineCriterion.findMany({
      where: { organizationId, projectId: null },
      orderBy: ordered,
    });
    return rows.map(toView);
  }

  private async overrides(db: Db, projectId: string): Promise<ProjectGuidelineOverrideView[]> {
    const rows = await db.guidelineCriterion.findMany({ where: { projectId }, orderBy: ordered });
    return rows.map((r): ProjectGuidelineOverrideView => {
      if (!r.overridesId) return { action: 'ADD', ...toView(r) };
      if (r.disabled) return { action: 'DISABLE', id: r.id, overridesId: r.overridesId };
      return { action: 'EDIT', ...toView(r), overridesId: r.overridesId };
    });
  }
}

type Db = Pick<PrismaClient, 'guidelineCriterion'>;

/** Row-locks the Organization so concurrent replaces of its guidelines run one after another. */
async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
}

function criterionText(c: GuidelineCriterionText): GuidelineCriterionText {
  return { title: c.title, description: c.description, kind: c.kind, required: c.required };
}

function toView(c: GuidelineCriterion): GuidelineCriterionView {
  return { id: c.id, ...criterionText(c) };
}
