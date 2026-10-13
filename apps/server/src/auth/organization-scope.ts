import { NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@vorasaan/db';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Organization scoping: a record read or changed by id must belong to an Organization the
 * caller is a member of. These are Prisma `where` fragments, so the check folds into the
 * query that loads the record (no extra statement), and the asserts below for routes that
 * only need to know the record is theirs. Outside the caller's Organization a record is a
 * 404, exactly like an unknown id: its existence is never revealed.
 */
export function organizationOf(userId: string) {
  return { memberships: { some: { userId } } } satisfies Prisma.OrganizationWhereInput;
}

/** An Organization the user administers. */
export function organizationAdministeredBy(userId: string) {
  return {
    memberships: { some: { userId, role: 'ADMIN' } },
  } satisfies Prisma.OrganizationWhereInput;
}

export function projectInOrganizationOf(userId: string) {
  return { organization: organizationOf(userId) } satisfies Prisma.ProjectWhereInput;
}

export function teamInOrganizationOf(userId: string) {
  return { project: projectInOrganizationOf(userId) } satisfies Prisma.TeamWhereInput;
}

export function featureInOrganizationOf(userId: string) {
  return { team: teamInOrganizationOf(userId) } satisfies Prisma.FeatureWhereInput;
}

/** 404 unless the Feature exists in the user's Organization. */
export async function assertFeatureInOrganization(
  db: Db,
  userId: string,
  featureId: string,
): Promise<void> {
  const found = await db.feature.count({
    where: { id: featureId, ...featureInOrganizationOf(userId) },
  });
  if (!found) throw new NotFoundException('Feature not found');
}

/** 404 unless the Team exists in the user's Organization. */
export async function assertTeamInOrganization(
  db: Db,
  userId: string,
  teamId: string,
): Promise<void> {
  const found = await db.team.count({ where: { id: teamId, ...teamInOrganizationOf(userId) } });
  if (!found) throw new NotFoundException('Team not found');
}

/** 404 unless the Project exists in the user's Organization. */
export async function assertProjectInOrganization(
  db: Db,
  userId: string,
  projectId: string,
): Promise<void> {
  const found = await db.project.count({
    where: { id: projectId, ...projectInOrganizationOf(userId) },
  });
  if (!found) throw new NotFoundException('Project not found');
}
