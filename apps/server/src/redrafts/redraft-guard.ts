import { ConflictException } from '@nestjs/common';
import type { PrismaClient, ProposalKind } from '@vorasaan/db';

/**
 * A Redraft still WRITING after this long was abandoned (the server stopped mid-call): it
 * no longer holds the proposal, and the next Request changes clears it.
 */
export const REDRAFT_ABANDONED_MS = 10 * 60_000;

type Db = Pick<PrismaClient, 'redraft'>;

/** The WRITING Redraft that still holds the proposal, if any. */
export function writingRedraft(db: Db, kind: ProposalKind, proposalId: string, now = new Date()) {
  return db.redraft.findFirst({
    where: {
      proposalKind: kind,
      proposalId,
      status: 'WRITING',
      createdAt: { gt: new Date(now.getTime() - REDRAFT_ABANDONED_MS) },
    },
    select: { number: true },
  });
}

/**
 * While a Redraft is being written, Approve waits for it (ADR 0013): the proposal is about
 * to change, and approving now would apply what the person asked to change. 409.
 */
export async function assertNotRedrafting(
  db: Db,
  kind: ProposalKind,
  proposalId: string,
): Promise<void> {
  const writing = await writingRedraft(db, kind, proposalId);
  if (writing) {
    throw new ConflictException(
      `Redraft ${writing.number} of this proposal is being written. Approve it once it is ready.`,
    );
  }
}

/** The Redraft the proposal holds now: its latest READY one, or 1 when never redrafted. */
export async function currentRedraft(
  db: Db,
  kind: ProposalKind,
  proposalId: string,
): Promise<number> {
  const latest = await db.redraft.findFirst({
    where: { proposalKind: kind, proposalId, status: 'READY' },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  return latest?.number ?? 1;
}
