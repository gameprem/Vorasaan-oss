import type { Prisma } from '@vorasaan/db';
import {
  type ActionCardView,
  type ConversationListItem,
  type ConversationMessageView,
  ConversationToolCall,
  type ConversationView,
  type GrillingConversationProgress,
  GrillingNote,
} from '@vorasaan/shared';
import { z } from 'zod';
import { fromRecordedModelColumns } from '../ai/recorded-model.ts';

export const conversationInclude = {
  project: { select: { id: true, name: true } },
  feature: { select: { id: true, title: true } },
  grillingRound: { select: { grillingId: true, kind: true, role: true } },
} satisfies Prisma.ConversationInclude;

export type ConversationWithScope = Prisma.ConversationGetPayload<{
  include: typeof conversationInclude;
}>;

type MessageRow = Prisma.ConversationMessageGetPayload<object>;

const StoredToolCalls = z.array(ConversationToolCall);
const StoredGrillingNotes = z.array(GrillingNote);

export function toConversationListItem(c: ConversationWithScope): ConversationListItem {
  return {
    id: c.id,
    title: c.title,
    scope: c.feature
      ? { kind: 'FEATURE', project: c.project, feature: c.feature }
      : { kind: 'PROJECT', project: c.project },
    grilling: c.grillingRound
      ? { id: c.grillingRound.grillingId, round: c.grillingRound.kind, role: c.grillingRound.role }
      : null,
    modelId: c.modelId,
    summarizedThrough: c.summarizedThrough,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toConversationMessageView(m: MessageRow): ConversationMessageView {
  const toolCalls = m.toolCalls === null ? null : StoredToolCalls.safeParse(m.toolCalls);
  const notes = m.grillingNotes === null ? null : StoredGrillingNotes.safeParse(m.grillingNotes);
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: toolCalls?.success ? toolCalls.data : null,
    toolCallId: m.toolCallId,
    model: fromRecordedModelColumns(m),
    modelNotice: m.modelNotice,
    grillingNotes: notes?.success ? notes.data : null,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toConversationView(
  c: ConversationWithScope,
  messages: MessageRow[],
  actionCards: ActionCardView[],
  grillingProgress: GrillingConversationProgress | null = null,
): ConversationView {
  return {
    ...toConversationListItem(c),
    messages: messages.map(toConversationMessageView),
    actionCards,
    grillingProgress,
  };
}
