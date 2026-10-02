import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';

/** Admins and the Feature's PO Role Owners edit and revert the Spec by hand. */
export async function assertCanEditSpec(db: PrismaClient, user: User, featureId: string) {
  const [admin, po] = await Promise.all([
    db.orgMembership.count({ where: { userId: user.id, role: 'ADMIN' } }),
    db.roleOwner.count({ where: { featureId, userId: user.id, role: 'PO' } }),
  ]);
  if (!admin && !po) {
    throw new ForbiddenException("Only an Admin or the Feature's PO can edit the Spec");
  }
}
