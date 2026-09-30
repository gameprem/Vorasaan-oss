import type { MeView } from '@vorasaan/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

// Server-side API access. The session token lives in an httpOnly cookie on the web
// origin and is forwarded as a Bearer token. With VORASAAN_DEV_AUTH=true the dev
// user switcher's cookie is forwarded as x-vorasaan-user instead.

export const SESSION_COOKIE = 'vorasaan_session';
export const DEV_USER_COOKIE = 'vorasaan-user';
export const API_URL = process.env.VORASAAN_API_URL ?? 'http://localhost:4000';

export const devAuth = () => process.env.VORASAAN_DEV_AUTH === 'true';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type ApiOptions = {
  method?: string;
  body?: unknown;
  /** Send the visitor to /login on 401 (default). Off for the layout and login itself. */
  redirectOnUnauthorized?: boolean;
};

/** The headers that identify the visitor to the API; empty when nobody is signed in. Server-only. */
export async function authHeaders(): Promise<Record<string, string>> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  if (session) return { authorization: `Bearer ${session}` };
  const devUser = devAuth() ? jar.get(DEV_USER_COOKIE)?.value : undefined;
  return devUser ? { 'x-vorasaan-user': devUser } : {};
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  // Read cookies outside the try: during prerendering, cookies() throws Next's
  // "dynamic usage" signal, which must propagate rather than become a network error.
  const auth = await authHeaders();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...auth,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, `Can't reach the Vorasaan server at ${API_URL}. Is it running?`);
  }

  if (res.status === 401 && options.redirectOnUnauthorized !== false) redirect('/login');

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = (body as { message?: unknown } | undefined)?.message;
    throw new ApiError(
      res.status,
      Array.isArray(message)
        ? message.join('; ')
        : typeof message === 'string'
          ? message
          : `Request failed (${res.status})`,
    );
  }
  return body as T;
}

/** The signed-in user, or null. Cached for the duration of one render. */
export const currentUser = cache(async (): Promise<MeView | null> => {
  try {
    return await api<MeView>('/me', { redirectOnUnauthorized: false });
  } catch {
    return null;
  }
});

export type DevUser = { id: string; name: string; email: string };
