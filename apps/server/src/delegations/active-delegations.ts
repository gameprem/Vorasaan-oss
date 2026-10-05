import type { PrismaClient, TeamRole } from '@vorasaan/db';

type ActiveDelegation = { teamId: string; role: TeamRole; delegatorId: string; delegateId: string };

/**
 * The Delegate of each given person for a Team Role in a Team at `at`
 * (startsAt ≤ at < endsAt), keyed by delegator. People without one are absent.
 * Overlaps are refused on create; should two exist anyway, the earliest start wins.
 */
export async function activeDelegates(
  db: Pick<PrismaClient, 'delegation'>,
  where: { teamId: string; role: TeamRole; delegatorIds: string[]; at: Date },
): Promise<Map<string, string>> {
  const rows = await delegationsActiveAt(db, {
    teamIds: [where.teamId],
    role: where.role,
    delegatorIds: where.delegatorIds,
    at: where.at,
  });
  return delegatesOf(rows, where);
}

/**
 * The Delegations active at `at` of these people in these Teams (for any role unless
 * given), earliest start first: read once for many requests, then picked per request
 * with `delegatesOf`.
 */
export function delegationsActiveAt(
  db: Pick<PrismaClient, 'delegation'>,
  where: { teamIds: string[]; role?: TeamRole; delegatorIds: string[]; at: Date },
): Promise<ActiveDelegation[]> {
  return db.delegation.findMany({
    where: {
      teamId: { in: where.teamIds },
      ...(where.role && { role: where.role }),
      delegatorId: { in: where.delegatorIds },
      startsAt: { lte: where.at },
      endsAt: { gt: where.at },
    },
    orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
    select: { teamId: true, role: true, delegatorId: true, delegateId: true },
  });
}

/** `activeDelegates` from rows `delegationsActiveAt` read. */
export function delegatesOf(
  rows: readonly ActiveDelegation[],
  where: { teamId: string; role: TeamRole; delegatorIds: readonly string[] },
): Map<string, string> {
  const delegators = new Set(where.delegatorIds);
  const byDelegator = new Map<string, string>();
  for (const row of rows) {
    if (row.teamId !== where.teamId || row.role !== where.role) continue;
    if (!delegators.has(row.delegatorId)) continue;
    if (!byDelegator.has(row.delegatorId)) byDelegator.set(row.delegatorId, row.delegateId);
  }
  return byDelegator;
}
