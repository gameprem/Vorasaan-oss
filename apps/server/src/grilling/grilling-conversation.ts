import type {
  GrillingRoundKind,
  GrillingRoundStatus,
  GrillingStatus,
  Prisma,
  TeamRole,
} from '@vorasaan/db';
import { MAX_GRILLING_FOLLOW_UPS } from '@vorasaan/shared';
import { z } from 'zod';
import type { Tx } from '../inbox/notifications.service.ts';

// Grilling Conversations (ticket 0044): each holder of a round's Team Role answers
// its questions in their own Conversation. What the server writes there is plain
// text it composes itself; only the follow-up questions come from the AI.

export const ROUND_LABEL: Record<GrillingRoundKind, string> = {
  BUSINESS: 'Business',
  UX: 'UX',
  TECHNICAL: 'Technical',
};

/**
 * Where a Grilling Conversation stands (`Conversation.grillingState`):
 * - `questionId`: the question being asked now; null when nothing is (all the
 *   owner's questions are done, or the round is over);
 * - `answer` and `followUps`: the owner's answer to it so far and the follow-ups
 *   asked on it (the last one's `answer` is null while it waits for a reply);
 *   recorded on the GrillingQuestion once the exchange ends;
 * - `skipped`: the questions the owner skipped here;
 * - `closed`: the owner was told the round is over.
 */
export const GrillingConversationState = z.object({
  questionId: z.string().nullable(),
  answer: z.string().nullable(),
  followUps: z.array(z.object({ question: z.string(), answer: z.string().nullable() })),
  skipped: z.array(z.string()),
  closed: z.boolean(),
});
export type GrillingConversationState = z.infer<typeof GrillingConversationState>;

export function stateOf(value: Prisma.JsonValue | null): GrillingConversationState {
  const parsed = GrillingConversationState.safeParse(value);
  return parsed.success ? parsed.data : asking(null, []);
}

export function toStateJson(state: GrillingConversationState): Prisma.InputJsonValue {
  return state as unknown as Prisma.InputJsonValue;
}

/** A state asking `questionId` from scratch. */
export function asking(questionId: string | null, skipped: string[]): GrillingConversationState {
  return { questionId, answer: null, followUps: [], skipped, closed: false };
}

type QuestionRow = {
  id: string;
  position: number;
  text: string;
  answeredAt: Date | null;
};

type RoundRow = {
  id: string;
  grillingId: string;
  kind: GrillingRoundKind;
  role: TeamRole;
  questions: QuestionRow[];
};

/** The first question nobody has answered, leaving out `skipped`. */
export function nextQuestion<Q extends QuestionRow>(
  questions: Q[],
  skipped: string[],
): Q | undefined {
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .find((q) => !q.answeredAt && !skipped.includes(q.id));
}

// ─── What the server writes ──────────────────────────────────────────────────

export function title(kind: GrillingRoundKind): string {
  return `Grilling: ${ROUND_LABEL[kind]} round`;
}

const SKIP_HINT = 'Type "skip" (or "ข้าม") to skip a question.';

export function intro(round: RoundRow): string {
  const total = round.questions.length;
  const answered = round.questions.filter((q) => q.answeredAt).length;
  const already = answered ? ` ${answered} of them already have an answer.` : '';
  return (
    `This is your Grilling Conversation for the ${ROUND_LABEL[round.kind]} round: ${total} ` +
    `questions for the people holding the ${round.role} Team Role, which I'll ask one at a time.${already} ` +
    `I may ask up to ${MAX_GRILLING_FOLLOW_UPS} follow-ups on an answer. Others holding the role may ` +
    `answer some questions too; I'll tell you when they do. ${SKIP_HINT}`
  );
}

export function ask(q: QuestionRow, total: number): string {
  return `Question ${q.position + 1} of ${total}: ${q.text}`;
}

export function recorded(q: QuestionRow): string {
  return `Thanks, I recorded your answer to question ${q.position + 1}.`;
}

export function skippedText(q: QuestionRow): string {
  return `Skipped question ${q.position + 1}.`;
}

function quote(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}

/** Someone else answered the question this Conversation was asking. */
export function answeredElsewhere(
  q: QuestionRow & { answer: string | null },
  by: string,
  hadReply: boolean,
): string {
  const lead = hadReply
    ? `${by} answered question ${q.position + 1} before you finished, so your reply to it wasn't recorded.`
    : `${by} answered question ${q.position + 1} meanwhile, so I won't ask it here.`;
  return `${lead} Their answer: "${quote(q.answer ?? '')}"`;
}

export function waiting(role: TeamRole, open: number): string {
  if (!open) return "That's all for now: every question you were asked has an answer.";
  return (
    `That's all I have for you for now. ${open} question${open === 1 ? ' is' : 's are'} still ` +
    `waiting for an answer: ${open === 1 ? 'one' : 'ones'} you skipped. Another holder of the ` +
    `${role} Team Role may answer ${open === 1 ? 'it' : 'them'}, or send any message here to go back to ${open === 1 ? 'it' : 'them'}.`
  );
}

/** The round is over, so nothing more is asked here. */
export function closedText(
  round: { kind: GrillingRoundKind; status: GrillingRoundStatus },
  grilling: { status: GrillingStatus },
): string {
  const label = ROUND_LABEL[round.kind];
  if (grilling.status === 'CANCELLED' && round.status === 'ASKING') {
    return 'This Grilling was cancelled, so there is nothing more to answer here.';
  }
  if (round.status === 'SKIPPED') {
    return `The ${label} round was skipped, so there is nothing more to answer here.`;
  }
  return `Every question has an answer now, so the ${label} round is complete. Thank you!`;
}

export function isOpen(
  round: { status: GrillingRoundStatus },
  grilling: { status: GrillingStatus },
): boolean {
  return round.status === 'ASKING' && grilling.status === 'RUNNING';
}

/**
 * Opens a Grilling Conversation for each of `ownerIds` (by default, everyone
 * holding the round's Team Role in the Project's Teams), inside the caller's
 * transaction: the introduction and the first question nobody has answered.
 * Someone who already has one for this round is left as they are.
 */
export async function openGrillingConversations(
  tx: Tx,
  g: { projectId: string },
  round: RoundRow,
  ownerIds?: string[],
): Promise<void> {
  const owners =
    ownerIds ??
    [
      ...new Set(
        (
          await tx.teamMembership.findMany({
            where: { role: round.role, team: { projectId: g.projectId } },
            select: { userId: true },
          })
        ).map((m) => m.userId),
      ),
    ].sort();
  const first = nextQuestion(round.questions, []);
  const content = first ? `${intro(round)}\n\n${ask(first, round.questions.length)}` : intro(round);
  for (const ownerId of owners) {
    const existing = await tx.conversation.findFirst({
      where: { grillingRoundId: round.id, ownerId },
      select: { id: true },
    });
    if (existing) continue;
    await tx.conversation.create({
      data: {
        ownerId,
        projectId: g.projectId,
        title: title(round.kind),
        grillingRoundId: round.id,
        grillingState: toStateJson(asking(first?.id ?? null, [])),
        messages: { create: { position: 0, role: 'ASSISTANT', content } },
      },
    });
  }
}
