import { Injectable } from '@nestjs/common';
import type { Attachment, AttachmentSource } from '@vorasaan/db';
import { type FileStorage, InjectFileStorage } from '../storage/file-storage.ts';
import { attachmentLimits } from './attachment.config.ts';
import { fetchUrl, UrlFetchError } from './fetch-url.ts';
import { htmlToText } from './html-to-text.ts';
import { capSnapshot, snapshotText } from './snapshot-text.ts';

export type Snapshot = {
  text: string | null;
  /** A title found in the content (e.g. the page's <title>), used when none was given. */
  title?: string | null;
  mimeType?: string | null;
};

export type SnapshotTarget = Pick<Attachment, 'url' | 'storageKey' | 'mimeType'>;

/**
 * Captures the current content of one kind of Attachment. There is one per
 * `AttachmentSource`; Confluence and Jira (ticket 0022) plug in here.
 */
export interface AttachmentSnapshotter {
  readonly source: AttachmentSource;
  capture(target: SnapshotTarget): Promise<Snapshot>;
}

export const ATTACHMENT_SNAPSHOTTERS = Symbol('ATTACHMENT_SNAPSHOTTERS');

/** Re-reads an uploaded file from `FileStorage`. */
@Injectable()
export class FileSnapshotter implements AttachmentSnapshotter {
  readonly source = 'FILE' as const;

  constructor(@InjectFileStorage() private readonly storage: FileStorage) {}

  async capture({ storageKey, mimeType }: SnapshotTarget): Promise<Snapshot> {
    if (!storageKey || !mimeType) throw new Error('A FILE Attachment needs a stored file');
    const bytes = await this.storage.get(storageKey);
    return { text: await snapshotText(bytes, mimeType, attachmentLimits().maxSnapshotChars) };
  }
}

const HTML = new Set(['text/html', 'application/xhtml+xml']);
const READABLE = new Set([...HTML, 'text/plain', 'text/markdown', 'application/pdf']);

/** Fetches a public web page (see `fetchUrl` for the SSRF rules). */
@Injectable()
export class UrlSnapshotter implements AttachmentSnapshotter {
  readonly source = 'URL' as const;

  async capture({ url }: SnapshotTarget): Promise<Snapshot> {
    if (!url) throw new Error('A URL Attachment needs a URL');
    const limits = attachmentLimits();
    const page = await fetchUrl(url, {
      maxBytes: limits.maxBytes,
      allowPrivate: limits.allowPrivateUrls,
    });
    if (!READABLE.has(page.mimeType)) {
      throw new UrlFetchError(`Can't read text from ${page.mimeType || 'this page'}`);
    }
    if (HTML.has(page.mimeType)) {
      const { title, text } = htmlToText(new TextDecoder().decode(page.bytes));
      return { title, text: capSnapshot(text, limits.maxSnapshotChars), mimeType: page.mimeType };
    }
    return {
      text: await snapshotText(page.bytes, page.mimeType, limits.maxSnapshotChars),
      mimeType: page.mimeType,
    };
  }
}
