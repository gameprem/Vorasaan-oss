import { z } from 'zod';
import { PersonRef } from './decision-request.ts';
import { AttachmentSource } from './enums.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();
const Title = z.string().trim().min(1).max(200);

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

/**
 * `POST /features/:id/attachments` with a JSON body attaches a public web page.
 * (The same route takes a multipart upload: an optional `title` field, then a `file`.)
 */
export const AddUrlAttachmentInput = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  /** Defaults to the page's <title>, or the URL. */
  title: Title.optional(),
});
export type AddUrlAttachmentInput = z.infer<typeof AddUrlAttachmentInput>;

/** Text fields of a multipart upload (they must precede the file part). */
export const UploadAttachmentFields = z.object({
  /** Defaults to the file name. */
  title: Title.optional(),
});
export type UploadAttachmentFields = z.infer<typeof UploadAttachmentFields>;

export const AttachmentView = z.object({
  id: Id,
  featureId: Id,
  source: AttachmentSource,
  title: z.string(),
  /** The page an Attachment was captured from (URL, Confluence, Jira), else null. */
  url: z.string().nullable(),
  mimeType: z.string().nullable(),
  /** True when the bytes can be downloaded from `GET /attachments/:id/file`. */
  hasFile: z.boolean(),
  /** The Snapshot: text the AI uses as context. Null when there is none (e.g. images). */
  snapshotText: z.string().nullable(),
  snapshotAt: Timestamp.nullable(),
  addedBy: PersonRef,
  createdAt: Timestamp,
});
export type AttachmentView = z.infer<typeof AttachmentView>;
