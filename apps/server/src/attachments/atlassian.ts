// Read-only access to the Organization's Atlassian Cloud site (Confluence and
// Jira REST APIs) with the Admin's email + API token.
//
// Credential safety: requests only ever go to the site an Admin configured.
// Attachment references (page URLs, issue URLs) are only parsed for an id or
// key, after checking they are on that site; redirects are never followed.

import { JIRA_ISSUE_KEY } from '@vorasaan/shared';
import { attachmentLimits } from './attachment.config.ts';
import { readCapped } from './fetch-url.ts';

export type AtlassianConnection = { siteUrl: string; email: string; apiToken: string };

/** An Atlassian reference or request failed; the message is safe to show (no secrets). */
export class AtlassianError extends Error {
  /** The HTTP status Atlassian answered with, when it answered. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class AtlassianNotConnectedError extends AtlassianError {
  constructor() {
    super(
      'Atlassian is not connected: an Admin adds the site URL, email and API token in Settings first',
    );
  }
}

/**
 * The site's origin, e.g. https://acme.atlassian.net. https only;
 * ATLASSIAN_ALLOW_HTTP=true allows http for local fakes (dev and tests).
 */
export function atlassianSite(input: string, env = process.env): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AtlassianError('Enter the site URL, e.g. https://acme.atlassian.net');
  }
  const httpAllowed = env.ATLASSIAN_ALLOW_HTTP === 'true' && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !httpAllowed) {
    throw new AtlassianError('The Atlassian site URL must start with https://');
  }
  if (url.username || url.password) {
    throw new AtlassianError('Put the email and API token in their own fields, not in the URL');
  }
  return new URL(url.origin);
}

/** A reference must be on the configured site, never on another host. */
function onSite(ref: string, site: URL, what: string, hint: string): URL {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new AtlassianError(`Enter ${hint}`);
  }
  if (url.origin !== site.origin) {
    throw new AtlassianError(
      `${what} URLs must be on ${site.host}, the Atlassian site in Settings`,
    );
  }
  return url;
}

const CONFLUENCE_HINT =
  'a Confluence page URL (…/wiki/spaces/KEY/pages/123456/Title) or the numeric page id';

/** The page id from a page id or a Confluence page URL on the site. */
export function confluencePageId(ref: string, site: URL): string {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const url = onSite(trimmed, site, 'Confluence page', CONFLUENCE_HINT);
  const id =
    url.searchParams.get('pageId') ??
    /\/pages\/(?:edit-v2\/|edit\/)?(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
  if (!id || !/^\d+$/.test(id)) throw new AtlassianError(`Enter ${CONFLUENCE_HINT}`);
  return id;
}

const JIRA_HINT = 'a Jira issue key (MB-42) or its URL (…/browse/MB-42)';

/** The issue key from a key or a Jira issue URL on the site. */
export function jiraIssueKey(ref: string, site: URL): string {
  const trimmed = ref.trim();
  if (JIRA_ISSUE_KEY.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
  const url = onSite(trimmed, site, 'Jira issue', JIRA_HINT);
  const key = (
    /\/browse\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? url.searchParams.get('selectedIssue')
  )?.toUpperCase();
  if (!key || !JIRA_ISSUE_KEY.test(key)) throw new AtlassianError(`Enter ${JIRA_HINT}`);
  return key;
}

export const confluencePageUrl = (site: URL, id: string) =>
  new URL(`/wiki/pages/viewpage.action?pageId=${id}`, site).toString();

export const jiraIssueUrl = (site: URL, key: string) => new URL(`/browse/${key}`, site).toString();

/**
 * GETs a JSON resource from the configured site. `path` is built by the caller
 * from validated ids only; `what` names it in errors ("Confluence page 123").
 */
export async function atlassianGet<T>(
  connection: AtlassianConnection,
  path: string,
  what: string,
): Promise<T> {
  const site = atlassianSite(connection.siteUrl);
  const url = new URL(path, site);
  if (url.origin !== site.origin) throw new AtlassianError('Refusing to leave the Atlassian site');

  const credentials = Buffer.from(`${connection.email}:${connection.apiToken}`).toString('base64');
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Basic ${credentials}`,
        accept: 'application/json',
        'user-agent': 'Vorasaan (Attachment Snapshot)',
      },
    });
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? 'it timed out' : 'it is unreachable';
    throw new AtlassianError(`Could not reach ${site.host}: ${reason}`);
  }

  if (!response.ok) {
    await response.body?.cancel();
    const { status } = response;
    const fail = (message: string) => new AtlassianError(message, status);
    if (status >= 300 && status < 400) {
      throw fail(
        `${site.host} answered with a redirect (HTTP ${status}); check the site URL in Settings`,
      );
    }
    if (status === 401) {
      throw fail(
        'Atlassian refused the credentials (HTTP 401); check the email and API token in Settings',
      );
    }
    if (status === 403 || status === 404) {
      throw fail(`${what} was not found, or the Atlassian account can't see it`);
    }
    throw fail(`Atlassian answered HTTP ${status} for ${what}`);
  }
  const bytes = await readCapped(response, attachmentLimits().maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new AtlassianError(`Atlassian sent an unreadable answer for ${what}`);
  }
}
