import { estimateTokens } from '../retrieval/token-estimate.ts';
import type { ChatMessageForAi } from './ai.port.ts';

/** What each message costs beyond its text (its role, its separators), roughly. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** The text of one message as the model reads it, tool calls included. */
export function messageText(m: ChatMessageForAi): string {
  if (m.role !== 'ASSISTANT' || !m.toolCalls?.length) return m.content;
  const calls = m.toolCalls.map(
    (c) => `(Called the tool ${c.name} with ${JSON.stringify(c.args)})`,
  );
  return [m.content, ...calls].filter((t) => t.trim()).join('\n\n');
}

/** What one message costs, by the script-aware estimate (ticket 0059). */
export function estimateMessageTokens(m: ChatMessageForAi): number {
  return estimateTokens(messageText(m)) + MESSAGE_OVERHEAD_TOKENS;
}

/**
 * The fallback of `AiPort.countTokens` (ticket 0060): the script-aware estimate
 * of the system text and every message.
 */
export function estimateChatTokens(input: { system: string; messages: ChatMessageForAi[] }) {
  return (
    estimateTokens(input.system) +
    input.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  );
}

/** The messages as one text, for a provider's counting API: "person:", "assistant:", "tool:". */
export function messagesAsText(messages: ChatMessageForAi[]): string {
  const who = { USER: 'person', ASSISTANT: 'assistant', TOOL: 'tool' } as const;
  return messages.map((m) => `${who[m.role]}: ${messageText(m)}`).join('\n\n');
}
