import type { Prisma } from '@vorasaan/db';
import {
  type ConversationListItem,
  type ConversationMessageView,
  ConversationToolCall,
  type ConversationView,
} from '@vorasaan/shared';
import { z } from 'zod';

export const conversationInclude = {
  project: { select: { id: true, name: true } },
  feature: { select: { id: true, title: true } },
} satisfies Prisma.ConversationInclude;

export type ConversationWithScope = Prisma.ConversationGetPayload<{
  include: typeof conversationInclude;
}>;

type MessageRow = Prisma.ConversationMessageGetPayload<object>;

const StoredToolCalls = z.array(ConversationToolCall);

export function toConversationListItem(c: ConversationWithScope): ConversationListItem {
  return {
    id: c.id,
    title: c.title,
    scope: c.feature
      ? { kind: 'FEATURE', project: c.project, feature: c.feature }
      : { kind: 'PROJECT', project: c.project },
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toConversationMessageView(m: MessageRow): ConversationMessageView {
  const toolCalls = m.toolCalls === null ? null : StoredToolCalls.safeParse(m.toolCalls);
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: toolCalls?.success ? toolCalls.data : null,
    toolCallId: m.toolCallId,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toConversationView(
  c: ConversationWithScope,
  messages: MessageRow[],
): ConversationView {
  return { ...toConversationListItem(c), messages: messages.map(toConversationMessageView) };
}
