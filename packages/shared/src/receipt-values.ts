// Plain values of receipt.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** The longest retention an Admin may set: ten years. */
export const MAX_RECEIPT_RETENTION_DAYS = 3650;
