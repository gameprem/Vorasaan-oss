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

const Ref = z.string().trim().min(1).max(2048);

/**
 * `POST /features/:id/attachments` with a JSON body attaches a public web page
 * (`source` "URL", the default), a Confluence page or a Jira issue. Confluence
 * and Jira are read from the Organization's Atlassian site (`/settings/atlassian`);
 * their URLs must be on that site.
 * (The same route takes a multipart upload: an optional `title` field, then a `file`.)
 */
export const AddUrlAttachmentInput = z.preprocess(
  (body) =>
    body && typeof body === 'object' && !('source' in body) ? { ...body, source: 'URL' } : body,
  z.discriminatedUnion('source', [
    z.object({
      source: z.literal('URL'),
      url: z.url({ protocol: /^https?$/ }).max(2048),
      /** Defaults to the page's <title>, or the URL. */
      title: Title.optional(),
    }),
    z.object({
      source: z.literal('CONFLUENCE'),
      /** A page URL on the Atlassian site, or the numeric page id. */
      page: Ref,
      /** Defaults to the page title. */
      title: Title.optional(),
    }),
    z.object({
      source: z.literal('JIRA'),
      /** An issue key (MB-42) or its URL on the Atlassian site. */
      issue: Ref,
      /** Defaults to "KEY: summary". */
      title: Title.optional(),
    }),
  ]),
);
/** The parsed body: `source` is always set (a body without one is a URL). */
export type AddUrlAttachmentInput = z.output<typeof AddUrlAttachmentInput>;

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
  /** The AI's short summary of the Snapshot. Null when there is none or the AI call failed. */
  summary: z.string().nullable(),
  addedBy: PersonRef,
  createdAt: Timestamp,
});
export type AttachmentView = z.infer<typeof AttachmentView>;
