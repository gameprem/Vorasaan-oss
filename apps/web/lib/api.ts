import { cookies } from 'next/headers';

// Server-side API access. The dev user switcher stores the acting user in a cookie,
// which is forwarded as x-vorasaan-user (DEV ONLY until real auth lands).

export const USER_COOKIE = 'vorasaan-user';
const API_URL = process.env.VORASAAN_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function currentUserId(): Promise<string | undefined> {
  return (await cookies()).get(USER_COOKIE)?.value;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const userId = await currentUserId();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        ...(userId ? { 'x-vorasaan-user': userId } : {}),
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, `Can't reach the Vorasaan server at ${API_URL}. Is it running?`);
  }
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

export type DevUser = { id: string; name: string; email: string };
