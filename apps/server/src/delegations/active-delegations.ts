import type { PrismaClient, TeamRole } from '@vorasaan/db';

/**
 * The Delegate of each given person for a Team Role in a Team at `at`
 * (startsAt ≤ at < endsAt), keyed by delegator. People without one are absent.
 * Overlaps are refused on create; should two exist anyway, the earliest start wins.
 */
export async function activeDelegates(
  db: PrismaClient,
  where: { teamId: string; role: TeamRole; delegatorIds: string[]; at: Date },
): Promise<Map<string, string>> {
  const rows = await db.delegation.findMany({
    where: {
      teamId: where.teamId,
      role: where.role,
      delegatorId: { in: where.delegatorIds },
      startsAt: { lte: where.at },
      endsAt: { gt: where.at },
    },
    orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
    select: { delegatorId: true, delegateId: true },
  });
  const byDelegator = new Map<string, string>();
  for (const row of rows) {
    if (!byDelegator.has(row.delegatorId)) byDelegator.set(row.delegatorId, row.delegateId);
  }
  return byDelegator;
}
