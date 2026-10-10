import { ForbiddenException } from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  BUILT_IN_DESIGN_TEMPLATES,
  type DesignTemplateKind,
  designDocRoles,
  designDocScope,
  type TeamRole,
} from '@vorasaan/shared';
import type { DesignDocForAi, FeatureForAi, PlatformForAi } from '../ai/ai.port.ts';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Who approves a Design Doc (ADR 0014, ticket 0069): for each of its Team Roles (Tech Lead,
 * and the Platform's, or QA for the QA Design Doc), the Feature's Role Owners holding it, or,
 * when the Feature has no Role Owner of that role, the Team's members holding it, as a
 * Decision Request's Recipients are chosen. Admins are not approvers by being Admins: a
 * Design Doc is the Platform's people's to settle.
 */
export async function designDocApprovers(
  db: Db,
  featureId: string,
  roles: readonly TeamRole[],
): Promise<{ userId: string; role: TeamRole; roleOwner: boolean }[]> {
  const [owners, members] = await Promise.all([
    db.roleOwner.findMany({
      where: { featureId, role: { in: [...roles] } },
      select: { userId: true, role: true },
    }),
    db.teamMembership.findMany({
      where: { team: { features: { some: { id: featureId } } }, role: { in: [...roles] } },
      select: { userId: true, role: true },
    }),
  ]);
  return approversFrom(roles, owners, members);
}

/** The rule above, on rows already read, in the order of `roles` then by id. */
export function approversFrom(
  roles: readonly TeamRole[],
  owners: readonly { userId: string; role: TeamRole }[],
  members: readonly { userId: string; role: TeamRole }[],
): { userId: string; role: TeamRole; roleOwner: boolean }[] {
  const out: { userId: string; role: TeamRole; roleOwner: boolean }[] = [];
  for (const role of roles) {
    const owning = owners.filter((o) => o.role === role);
    const from = owning.length ? owning : members.filter((m) => m.role === role);
    for (const { userId } of [...from].sort((a, b) => (a.userId < b.userId ? -1 : 1))) {
      out.push({ userId, role, roleOwner: owning.length > 0 });
    }
  }
  return out;
}

/** 403 unless `user` approves this Design Doc. */
export async function assertDesignDocApprover(
  db: Db,
  user: User,
  featureId: string,
  roles: readonly TeamRole[],
  what = 'approve this Design Doc',
): Promise<void> {
  const approvers = await designDocApprovers(db, featureId, roles);
  if (!approvers.some((a) => a.userId === user.id)) {
    throw new ForbiddenException(
      `Only a Tech Lead or a Role Owner of ${roles.filter((r) => r !== 'TECH_LEAD').join(' or ') || 'its Team Roles'} can ${what}`,
    );
  }
}

/** A Design Doc's Team Roles from its Platform's (null for QA). */
export function rolesOf(platform: { roles: TeamRole[] } | null): TeamRole[] {
  return designDocRoles(platform?.roles ?? null);
}

/** The Project's template of this kind, or the built-in one. */
export async function designTemplateMarkdown(
  db: Db,
  projectId: string,
  kind: DesignTemplateKind,
): Promise<string> {
  const own = await db.designTemplate.findUnique({
    where: { projectId_kind: { projectId, kind } },
    select: { markdown: true },
  });
  return own?.markdown ?? BUILT_IN_DESIGN_TEMPLATES[kind];
}

/**
 * What the AI is given about a Design Doc: the Feature, the Design Doc (its Platform, the
 * Feature's targets, its template) and the part of a Spec it covers.
 */
export async function designDocForAi(
  db: Db,
  designDocId: string,
): Promise<{
  projectId: string;
  featureId: string;
  feature: FeatureForAi;
  doc: DesignDocForAi;
  /** What the Design Doc covers of a Spec. */
  scope: (specMarkdown: string) => string;
}> {
  const doc = await db.designDoc.findUniqueOrThrow({
    where: { id: designDocId },
    select: {
      template: true,
      featureId: true,
      platform: { select: { name: true, roles: true } },
      feature: {
        select: {
          title: true,
          description: true,
          team: { select: { projectId: true } },
        },
      },
    },
  });
  const [targets, template] = await Promise.all([
    db.platform.findMany({
      where: { features: { some: { featureId: doc.featureId } } },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { name: true, roles: true },
    }),
    designTemplateMarkdown(db, doc.feature.team.projectId, doc.template),
  ]);
  const platform: PlatformForAi | null = doc.platform
    ? { name: doc.platform.name, roles: doc.platform.roles }
    : null;
  const names = targets.map((t) => t.name);
  return {
    projectId: doc.feature.team.projectId,
    featureId: doc.featureId,
    feature: { title: doc.feature.title, description: doc.feature.description ?? '' },
    doc: {
      name: platform?.name ?? 'QA',
      platform,
      targets: targets.map((t) => ({ name: t.name, roles: t.roles })),
      template,
    },
    scope: (markdown) => designDocScope(markdown, platform?.name ?? null, names),
  };
}
