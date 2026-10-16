// Plain values of conversation.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** The longest message a person can send. */
export const MAX_CONVERSATION_MESSAGE_CHARS = 20_000;
