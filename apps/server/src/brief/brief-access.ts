import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';

export type ProjectAccess = { organizationId: string; canEdit: boolean; isAdmin: boolean };

/**
 * Who may do what with a Project's Brief and Project Attachments: everyone in
 * the Project's Organization reads; its Admins and the POs of any of the
 * Project's Teams edit. 404 for an unknown Project and, so its existence isn't revealed,
 * for someone outside its Organization. `notFound` is the message, for a record reached
 * through its Project (a Brief Proposal, a Grilling), so it reads as that record's 404.
 */
export async function projectAccess(
  db: PrismaClient,
  user: User,
  projectId: string,
  notFound = 'Project not found',
): Promise<ProjectAccess> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundException(notFound);
  const { organizationId } = project;
  const membership = await db.orgMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId: user.id } },
    select: { role: true },
  });
  if (!membership) throw new NotFoundException(notFound);
  if (membership.role === 'ADMIN') return { organizationId, canEdit: true, isAdmin: true };
  const po = await db.teamMembership.count({
    where: { userId: user.id, role: 'PO', team: { projectId } },
  });
  return { organizationId, canEdit: po > 0, isAdmin: false };
}

export async function assertCanEditProject(
  db: PrismaClient,
  user: User,
  projectId: string,
  notFound?: string,
): Promise<ProjectAccess> {
  const access = await projectAccess(db, user, projectId, notFound);
  if (!access.canEdit) {
    throw new ForbiddenException(
      "Only an Admin or a PO of one of this Project's Teams can do this",
    );
  }
  return access;
}
