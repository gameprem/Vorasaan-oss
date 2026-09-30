import type { MeView } from '@vorasaan/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

// Server-side API access. The session token lives in an httpOnly cookie on the web
// origin and is forwarded as a Bearer token. With VORASAAN_DEV_AUTH=true the dev
// user switcher's cookie is forwarded as x-vorasaan-user instead.

export const SESSION_COOKIE = 'vorasaan_session';
export const DEV_USER_COOKIE = 'vorasaan-user';
const API_URL = process.env.VORASAAN_API_URL ?? 'http://localhost:4000';

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

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const devUser = devAuth() ? jar.get(DEV_USER_COOKIE)?.value : undefined;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...(!session && devUser ? { 'x-vorasaan-user': devUser } : {}),
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
