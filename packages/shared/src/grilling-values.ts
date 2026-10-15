// Plain values of grilling.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/**
 * The most follow-ups the AI may ask on one question in a Grilling Conversation
 * (ticket 0044). The server enforces it, whatever the AI says.
 */
export const MAX_GRILLING_FOLLOW_UPS = 2;
