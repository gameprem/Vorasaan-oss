import type { PrismaClient } from '@vorasaan/db';
import type { AttachmentForAi } from '../ai/ai.port.ts';

/**
 * How many characters of Attachment text each AI task may receive. Fixed so a
 * Feature with many or long Attachments can't blow up a prompt's size or cost.
 */
export const ATTACHMENT_CONTEXT_BUDGET = {
  /** Choice generation and Spec Proposal drafting: the Spec and request matter most. */
  decisionRequest: 12_000,
  /** Drafting a Spec from Attachments: they are the main input. */
  specFromAttachments: 60_000,
  /** Summarising one Attachment. */
  summary: 60_000,
} as const;

export const CONTEXT_TRUNCATION_MARKER = '\n[Shortened to fit the AI context budget]';

/** Leftover budget below this isn't worth a fragment of another Attachment. */
const MIN_FRAGMENT = 200;

/** Cuts `text` to at most `maxChars` characters, marker included. */
export function clipForAi(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, Math.max(0, maxChars - CONTEXT_TRUNCATION_MARKER.length)) +
    CONTEXT_TRUNCATION_MARKER
  );
}

/** Keeps Attachments in order until `budgetChars` of text is used; cuts the last one to fit. */
export function fitToBudget(
  attachments: AttachmentForAi[],
  budgetChars: number,
): AttachmentForAi[] {
  const fitted: AttachmentForAi[] = [];
  let remaining = budgetChars;
  for (const attachment of attachments) {
    if (remaining < MIN_FRAGMENT && remaining < attachment.text.length) break;
    const text = clipForAi(attachment.text, remaining);
    fitted.push({ ...attachment, text });
    remaining -= text.length;
  }
  return fitted;
}

/**
 * The Feature's Attachments that have Snapshot text, most recent Snapshot first,
 * as AI context within `budgetChars`. With `preferSummary`, an Attachment's
 * summary stands in for its Snapshot when there is one.
 */
export async function attachmentsForAi(
  db: PrismaClient,
  featureId: string,
  options: { budgetChars: number; preferSummary: boolean },
): Promise<AttachmentForAi[]> {
  const rows = await db.attachment.findMany({
    where: { featureId, snapshotText: { not: null } },
    orderBy: [{ snapshotAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: { title: true, source: true, snapshotText: true, summary: true },
  });
  const attachments = rows
    .map((row) => ({
      title: row.title,
      source: row.source,
      text: ((options.preferSummary && row.summary) || row.snapshotText || '').trim(),
    }))
    .filter((a) => a.text.length > 0);
  return fitToBudget(attachments, options.budgetChars);
}
