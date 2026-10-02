import { timingSafeEqual } from 'node:crypto';
import type { ChatProvider } from '@vorasaan/shared';

/**
 * A provider API call that failed. Its message names the provider and the status only:
 * never the URL's query, the request, the response body or a token.
 */
export class ChatApiError extends Error {
  constructor(
    readonly provider: ChatProvider,
    readonly status: number | null,
  ) {
    super(`${provider} API call failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

/** The provider APIs. Overridable only so tests and local development can use fakes. */
export function chatApiUrls(env: Record<string, string | undefined> = process.env) {
  return {
    line: (env.VORASAAN_LINE_API_URL || 'https://api.line.me').replace(/\/+$/, ''),
    slack: (env.VORASAAN_SLACK_API_URL || 'https://slack.com/api').replace(/\/+$/, ''),
    teamsToken:
      env.VORASAAN_TEAMS_TOKEN_URL ||
      'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token',
    teamsOpenId:
      env.VORASAAN_TEAMS_OPENID_URL ||
      'https://login.botframework.com/v1/.well-known/openidconfiguration',
  };
}

const TIMEOUT_MS = 5_000;

/**
 * POSTs to a provider API and returns the parsed JSON (or null). Redirects are refused,
 * so a token is only ever sent to the URL it was meant for.
 */
export async function providerPost(
  provider: ChatProvider,
  url: string,
  init: { headers: Record<string, string>; body: string },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ChatApiError(provider, null);
  }
  if (!res.ok) throw new ChatApiError(provider, res.status);
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function providerGetJson(provider: ChatProvider, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ChatApiError(provider, null);
  }
  if (!res.ok) throw new ChatApiError(provider, res.status);
  try {
    return await res.json();
  } catch {
    throw new ChatApiError(provider, res.status);
  }
}

/** Compares two byte strings in time that doesn't depend on where they differ. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  // Lengths are public (a hex or base64 digest has a fixed one); only contents are secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** The body as JSON, or null when it is not JSON. Only for bodies already verified. */
export function safeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}
