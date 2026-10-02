import type {
  GrillingRoundKind,
  GrillingRoundStatus,
  GrillingStatus,
  Prisma,
  TeamRole,
} from '@vorasaan/db';
import {
  type GrillingNote,
  grillingNotesText,
  MAX_GRILLING_FOLLOW_UPS,
  quoteAnswer,
} from '@vorasaan/shared';
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
// As Grilling Notes (ticket 0047): the facts, stored with the message so a client
// shows them in the reader's language; the message's `content` is them in English.

export function title(kind: GrillingRoundKind): string {
  return `Grilling: ${ROUND_LABEL[kind]} round`;
}

export function intro(round: RoundRow): GrillingNote {
  return {
    kind: 'INTRO',
    round: round.kind,
    role: round.role,
    total: round.questions.length,
    answered: round.questions.filter((q) => q.answeredAt).length,
    maxFollowUps: MAX_GRILLING_FOLLOW_UPS,
  };
}

export function ask(q: QuestionRow, total: number): GrillingNote {
  return { kind: 'ASK', position: q.position, total, text: q.text };
}

export function recorded(q: QuestionRow): GrillingNote {
  return { kind: 'RECORDED', position: q.position };
}

export function skippedText(q: QuestionRow): GrillingNote {
  return { kind: 'SKIPPED', position: q.position };
}

/** Someone else answered the question this Conversation was asking. */
export function answeredElsewhere(
  q: QuestionRow & { answer: string | null },
  by: string,
  hadReply: boolean,
): GrillingNote {
  return {
    kind: 'ANSWERED_ELSEWHERE',
    position: q.position,
    by,
    answer: quoteAnswer(q.answer ?? ''),
    hadReply,
  };
}

export function waiting(role: TeamRole, open: number): GrillingNote {
  return { kind: 'WAITING', role, open };
}

/** The round is over, so nothing more is asked here. */
export function closedText(
  round: { kind: GrillingRoundKind; status: GrillingRoundStatus },
  grilling: { status: GrillingStatus },
): GrillingNote {
  const reason =
    grilling.status === 'CANCELLED' && round.status === 'ASKING'
      ? 'CANCELLED'
      : round.status === 'SKIPPED'
        ? 'ROUND_SKIPPED'
        : 'COMPLETE';
  return { kind: 'CLOSED', round: round.kind, reason };
}

/** A server-written message: its notes, and the same in English as its `content`. */
export function noteMessage(notes: GrillingNote[]): {
  content: string;
  grillingNotes: Prisma.InputJsonValue;
} {
  return {
    content: grillingNotesText(notes, 'en'),
    grillingNotes: notes as unknown as Prisma.InputJsonValue,
  };
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
  const message = noteMessage(
    first ? [intro(round), ask(first, round.questions.length)] : [intro(round)],
  );
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
        messages: { create: { position: 0, role: 'ASSISTANT', ...message } },
      },
    });
  }
}

/** Where the drafted Brief Proposal was put for its starter (ticket 0047). */
export type BriefCardPlaced = {
  ownerId: string;
  messageId: string;
  cardId: string;
};

/** The title of the Project Conversation opened for a starter who has no Grilling Conversation. */
export function briefConversationTitle(project: string): string {
  return `Brief Proposal for ${project}`;
}

/**
 * When a Grilling drafts its Brief Proposal (ticket 0047), inside the caller's
 * transaction: a server-written message in the starter's latest Grilling
 * Conversation of this Grilling (or, when they have none, in a new Project
 * Conversation of theirs) and, under it, a BRIEF_PROPOSAL Action Card the
 * starter approves. The card isn't made by a tool call, so its `toolCallId`
 * names the Grilling instead.
 */
export async function placeBriefProposal(
  tx: Tx,
  g: { id: string; projectId: string; startedById: string },
  proposal: { id: string; summary: string | null },
): Promise<BriefCardPlaced> {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: g.projectId },
    select: { name: true },
  });
  const message = noteMessage([{ kind: 'BRIEF_DRAFTED', project: project.name }]);
  const latest = await tx.conversation.findFirst({
    where: { ownerId: g.startedById, grillingRound: { grillingId: g.id } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    select: { id: true },
  });
  let conversationId: string;
  let messageId: string;
  if (latest) {
    const { _max } = await tx.conversationMessage.aggregate({
      where: { conversationId: latest.id },
      _max: { position: true },
    });
    const created = await tx.conversationMessage.create({
      data: {
        conversationId: latest.id,
        position: (_max.position ?? -1) + 1,
        role: 'ASSISTANT',
        ...message,
      },
    });
    await tx.conversation.update({ where: { id: latest.id }, data: { updatedAt: new Date() } });
    conversationId = latest.id;
    messageId = created.id;
  } else {
    const created = await tx.conversation.create({
      data: {
        ownerId: g.startedById,
        projectId: g.projectId,
        title: briefConversationTitle(project.name),
        messages: { create: { position: 0, role: 'ASSISTANT', ...message } },
      },
      include: { messages: { select: { id: true } } },
    });
    conversationId = created.id;
    messageId = created.messages[0]?.id ?? '';
  }
  const card = await tx.actionCard.create({
    data: {
      conversationId,
      messageId,
      toolCallId: `grilling:${g.id}`,
      kind: 'BRIEF_PROPOSAL',
      targetId: proposal.id,
      title: `Change the Project Brief of "${project.name}"`,
      summary: proposal.summary,
    },
  });
  return { ownerId: g.startedById, messageId, cardId: card.id };
}
