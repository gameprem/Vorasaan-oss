// Plain values of ai-usage.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** The longest range one query may cover. */
export const AI_USAGE_MAX_DAYS = 366;

/** The days of a task's Receipts a model suggestion prices its calls from. */
export const MODEL_SUGGESTION_DAYS = 30;
