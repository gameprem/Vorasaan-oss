import type { Prisma, PrismaClient } from '@vorasaan/db';
import { GRILLING_ROUNDS } from '@vorasaan/shared';

/**
 * The RUNNING Grillings whose current round waits for `userId`: those of the
 * Projects where they hold the round's Team Role in one of the Teams. Null when
 * they hold none of the Grilling Team Roles anywhere. Shared by
 * `GET /grillings?awaiting=me` and the Inbox, so both always agree.
 */
export async function awaitingGrillingsWhere(
  db: PrismaClient,
  userId: string,
): Promise<Prisma.GrillingWhereInput | null> {
  const memberships = await db.teamMembership.findMany({
    where: { userId, role: { in: GRILLING_ROUNDS.map((r) => r.role) } },
    select: { role: true, team: { select: { projectId: true } } },
  });
  if (!memberships.length) return null;
  return {
    status: 'RUNNING',
    OR: memberships.map((m) => ({
      projectId: m.team.projectId,
      rounds: { some: { status: 'ASKING', role: m.role } },
    })),
  };
}
