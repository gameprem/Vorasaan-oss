import { Injectable } from '@nestjs/common';
import type { Attachment, AttachmentSource } from '@vorasaan/db';
import { AtlassianSettingsService } from '../settings/atlassian-settings.service.ts';
import { type FileStorage, InjectFileStorage } from '../storage/file-storage.ts';
import { adfToText } from './adf-to-text.ts';
import {
  atlassianGet,
  atlassianSite,
  confluencePageId,
  confluencePageUrl,
  jiraIssueKey,
  jiraIssueUrl,
} from './atlassian.ts';
import { attachmentLimits } from './attachment.config.ts';
import { fetchUrl, UrlFetchError } from './fetch-url.ts';
import { htmlToText } from './html-to-text.ts';
import { capSnapshot, snapshotText } from './snapshot-text.ts';

export type Snapshot = {
  text: string | null;
  /** A title found in the content (e.g. the page's <title>), used when none was given. */
  title?: string | null;
  mimeType?: string | null;
  /** The canonical address of what was captured, stored as the Attachment's `url`. */
  url?: string;
};

export type SnapshotTarget = Pick<Attachment, 'url' | 'storageKey' | 'mimeType'>;

/**
 * Captures the current content of one kind of Attachment. There is one per
 * `AttachmentSource`. `target.url` is what was attached: a web address, a
 * Confluence page URL or id, or a Jira issue key or URL.
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

type ConfluencePage = {
  title?: string;
  body?: { view?: { value?: string }; storage?: { value?: string } };
};

/** A Confluence page on the Organization's Atlassian site: its title and body as text. */
@Injectable()
export class ConfluenceSnapshotter implements AttachmentSnapshotter {
  readonly source = 'CONFLUENCE' as const;

  constructor(private readonly atlassian: AtlassianSettingsService) {}

  async capture({ url }: SnapshotTarget): Promise<Snapshot> {
    if (!url) throw new Error('A CONFLUENCE Attachment needs a page');
    const connection = await this.atlassian.requireConnection();
    const site = atlassianSite(connection.siteUrl);
    const id = confluencePageId(url, site);
    const page = await atlassianGet<ConfluencePage>(
      connection,
      `/wiki/rest/api/content/${id}?expand=body.view,body.storage`,
      `Confluence page ${id}`,
    );
    const title = page.title?.trim() || null;
    const body = htmlToText(page.body?.view?.value ?? page.body?.storage?.value ?? '').text;
    const text = [title && `# ${title}`, body].filter(Boolean).join('\n\n');
    return {
      title,
      text: capSnapshot(text, attachmentLimits().maxSnapshotChars),
      url: confluencePageUrl(site, id),
    };
  }
}

type JiraIssue = {
  key?: string;
  fields?: { summary?: string; status?: { name?: string }; description?: unknown };
};

/** A Jira issue on the Organization's Atlassian site: key, summary, status and description. */
@Injectable()
export class JiraSnapshotter implements AttachmentSnapshotter {
  readonly source = 'JIRA' as const;

  constructor(private readonly atlassian: AtlassianSettingsService) {}

  async capture({ url }: SnapshotTarget): Promise<Snapshot> {
    if (!url) throw new Error('A JIRA Attachment needs an issue');
    const connection = await this.atlassian.requireConnection();
    const site = atlassianSite(connection.siteUrl);
    const key = jiraIssueKey(url, site);
    const issue = await atlassianGet<JiraIssue>(
      connection,
      `/rest/api/3/issue/${key}?fields=summary,status,description`,
      `Jira issue ${key}`,
    );
    const summary = issue.fields?.summary?.trim() ?? '';
    const heading = summary ? `${key}: ${summary}` : key;
    const status = issue.fields?.status?.name;
    const description = adfToText(issue.fields?.description);
    const text = [heading, status && `Status: ${status}`, description && `\n${description}`]
      .filter(Boolean)
      .join('\n');
    return {
      title: heading,
      text: capSnapshot(text, attachmentLimits().maxSnapshotChars),
      url: jiraIssueUrl(site, key),
    };
  }
}
