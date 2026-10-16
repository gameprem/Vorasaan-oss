// Plain values of attachment.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/**
 * File types an Attachment upload accepts, by extension, with the media type
 * the server stores and serves. Anything else is rejected with 415.
 */
export const ATTACHMENT_FILE_TYPES = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;
