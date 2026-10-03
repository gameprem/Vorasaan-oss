import { BadRequestException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@vorasaan/db';
import { MESSAGE_PAGE_SIZE, type MessagePageInfo } from '@vorasaan/shared';
import { conversationNotFound } from './conversation-errors.ts';

// Pages of a Conversation's messages, like a chat app (ticket 0066). A page is a run
// of positions: `position` is the Conversation's own write order, unique per
// Conversation (and indexed with it), so a cursor that names one message never skips
// or repeats one, whatever arrives meanwhile or whatever shares a timestamp.

type MessageRow = Prisma.ConversationMessageGetPayload<object>;
type Db = Pick<PrismaClient, 'conversationMessage'>;

export type PageQuery = { before?: string; after?: string; around?: string; limit?: number };
export type MessagePage = MessagePageInfo & { messages: MessageRow[] };

/** A cursor names one message: its position and its id, base64url-encoded. */
export function toCursor(m: { position: number; id: string }): string {
  return Buffer.from(`${m.position}.${m.id}`).toString('base64url');
}

/** The position a cursor names, once it is checked to be a message of this Conversation. */
async function positionOf(db: Db, conversationId: string, cursor: string): Promise<number> {
  const invalid = () => new BadRequestException('That cursor is not one of this Conversation');
  const [position, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
  if (!position || !id || !/^\d+$/.test(position)) throw invalid();
  const found = await db.conversationMessage.findFirst({
    where: { id, conversationId, position: Number(position) },
    select: { position: true },
  });
  if (!found) throw invalid();
  return found.position;
}

/** `limit` messages older than `position` (all when null), oldest first; and whether more are older. */
async function older(db: Db, conversationId: string, position: number | null, limit: number) {
  const rows = await db.conversationMessage.findMany({
    where: { conversationId, ...(position === null ? {} : { position: { lt: position } }) },
    orderBy: { position: 'desc' },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit).reverse(), more: rows.length > limit };
}

/** `limit` messages from `position` on (after it, unless `inclusive`), oldest first; and whether more follow. */
async function newer(
  db: Db,
  conversationId: string,
  position: number,
  limit: number,
  inclusive = false,
) {
  const rows = await db.conversationMessage.findMany({
    where: { conversationId, position: inclusive ? { gte: position } : { gt: position } },
    orderBy: { position: 'asc' },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

function page(rows: MessageRow[], hasOlder: boolean, hasNewer: boolean): MessagePage {
  const first = rows[0];
  const last = rows.at(-1);
  return {
    messages: rows,
    olderCursor: hasOlder && first ? toCursor(first) : null,
    newerCursor: hasNewer && last ? toCursor(last) : null,
  };
}

/**
 * One page of the Conversation's messages, oldest first. The caller has checked
 * that the reader owns the Conversation. `around` a message of another Conversation
 * is a 404; a cursor that isn't one of this Conversation's is a 400.
 */
export async function loadMessagePage(
  db: Db,
  conversationId: string,
  query: PageQuery,
): Promise<MessagePage> {
  const limit = query.limit ?? MESSAGE_PAGE_SIZE;
  if (query.before) {
    const position = await positionOf(db, conversationId, query.before);
    const { rows, more } = await older(db, conversationId, position, limit);
    return page(rows, more, true);
  }
  if (query.after) {
    const position = await positionOf(db, conversationId, query.after);
    const { rows, more } = await newer(db, conversationId, position, limit);
    return page(rows, true, more);
  }
  if (query.around) {
    const target = await db.conversationMessage.findFirst({
      where: { id: query.around, conversationId },
      select: { position: true },
    });
    if (!target) throw conversationNotFound();
    // Half the page before the message, the rest from it on; a short side gives its room to the other.
    const before = await older(db, conversationId, target.position, limit);
    const after = await newer(db, conversationId, target.position, limit, true);
    let olderCount = Math.min(before.rows.length, Math.floor(limit / 2));
    const newerCount = Math.min(after.rows.length, limit - olderCount);
    olderCount = Math.min(before.rows.length, limit - newerCount);
    const rows = [
      ...before.rows.slice(before.rows.length - olderCount),
      ...after.rows.slice(0, newerCount),
    ];
    return page(
      rows,
      before.more || olderCount < before.rows.length,
      after.more || newerCount < after.rows.length,
    );
  }
  const { rows, more } = await older(db, conversationId, null, limit);
  return page(rows, more, false);
}
