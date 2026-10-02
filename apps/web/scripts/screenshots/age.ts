// Spreads the story over the past days. Everything was just written, so every time on
// screen would read "just now"; no API sets when something happened, so this is the one
// place that writes to the database directly (only timestamps, only in the _screens one).

import type { SQL } from 'bun';
import { REQUESTS } from './story';

const HOUR = 3_600_000;

export async function ageStory(db: SQL) {
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR);

  // The Project Brief and the first Spec Versions: from the kickoff, twelve days ago.
  await db`UPDATE "BriefVersion" SET "createdAt" = ${at(12 * 24 + 3)}`;
  await db`UPDATE "SpecVersion" SET "createdAt" = ${at(12 * 24)} WHERE version = 1`;

  for (const r of REQUESTS) {
    const sent = at(r.hoursAgo);
    const [request] = await db`SELECT id FROM "DecisionRequest" WHERE title = ${r.title}`;
    if (!request) throw new Error(`No Decision Request "${r.title}"`);
    const decided = r.decide ? at(r.hoursAgo - 3) : null;
    await db`
      UPDATE "DecisionRequest"
      SET "createdAt" = ${at(r.hoursAgo + 0.1)}, "submittedAt" = ${sent},
          "closedAt" = ${decided}, "updatedAt" = ${decided ?? sent}
      WHERE id = ${request.id}`;
    await db`UPDATE "Notification" SET "createdAt" = ${decided ?? sent} WHERE "requestId" = ${request.id}`;
    if (!decided) continue;
    const reviewed = new Date(decided.getTime() + 0.5 * HOUR);
    const [decision] = await db`
      UPDATE "Decision" SET "createdAt" = ${decided} WHERE "requestId" = ${request.id} RETURNING id`;
    const [proposal] = await db`
      UPDATE "SpecProposal"
      SET "createdAt" = ${new Date(decided.getTime() + 60_000)},
          "reviewedAt" = CASE WHEN "reviewedAt" IS NULL THEN NULL ELSE ${reviewed}::timestamp END
      WHERE "decisionId" = ${decision?.id} RETURNING id`;
    const [version] = await db`
      UPDATE "SpecVersion" SET "createdAt" = ${reviewed} WHERE "proposalId" = ${proposal?.id} RETURNING id`;
    if (version) {
      await db`UPDATE "Notification" SET "createdAt" = ${reviewed} WHERE "specVersionId" = ${version.id}`;
    }
  }

  // A Spec Proposal drafted in a Conversation (not after a Decision): this afternoon.
  await db`UPDATE "SpecProposal" SET "createdAt" = ${at(0.4)} WHERE "decisionId" IS NULL`;

  // The Grilling started this morning; its answers came in over the day.
  await db`UPDATE "Grilling" SET "createdAt" = ${at(3)}`;
  await db`UPDATE "GrillingRound" SET "createdAt" = ${at(3)}`;
  const answered = await db`
    SELECT id FROM "GrillingQuestion" WHERE "answeredAt" IS NOT NULL ORDER BY "answeredAt"`;
  for (const [i, q] of answered.entries()) {
    await db`UPDATE "GrillingQuestion" SET "answeredAt" = ${at(2 - i * 0.75)} WHERE id = ${q.id}`;
  }
}
