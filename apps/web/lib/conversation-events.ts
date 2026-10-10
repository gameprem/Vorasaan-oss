import type { ServerEvent, ServerEventName } from '@vorasaan/shared';

// The `conversation.*` events of the signed-in user's event stream (ticket 0046). The one
// EventSource lives in LiveUpdates; it hands these on as a window event, so the chat view
// doesn't open a second stream.

export type ConversationEvent = Extract<ServerEvent, { event: `conversation.${string}` }>;

export const CONVERSATION_EVENT_NAMES = [
  'conversation.delta',
  'conversation.done',
  'conversation.failed',
  'conversation.step',
  'conversation.appended',
  'conversation.usage',
  'conversation.compacted',
  'conversation.actionCard.created',
  'conversation.actionCard.updated',
] as const satisfies readonly ConversationEvent['event'][] & readonly ServerEventName[];

/** The window event that carries one `ConversationEvent` as its `detail`. */
export const CONVERSATION_EVENT = 'vorasaan:conversation';

export function dispatchConversationEvent(event: ConversationEvent) {
  window.dispatchEvent(new CustomEvent<ConversationEvent>(CONVERSATION_EVENT, { detail: event }));
}

/** Calls `listener` with each conversation event until the returned function is called. */
export function onConversationEvent(listener: (event: ConversationEvent) => void) {
  const handle = (e: Event) => listener((e as CustomEvent<ConversationEvent>).detail);
  window.addEventListener(CONVERSATION_EVENT, handle);
  return () => window.removeEventListener(CONVERSATION_EVENT, handle);
}
