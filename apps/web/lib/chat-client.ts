// The browser's side of the chat view's calls (ticket 0046), to the same-origin route
// handlers in app/api/conversations and app/api/action-cards (see lib/api-proxy.ts).

export type PostResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; body: unknown };

export async function postJson<T>(url: string, body?: unknown): Promise<PostResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Can't reach Vorasaan. Check your connection and try again.",
      body: null,
    };
  }
  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  if (res.status === 401) window.location.assign('/login');
  const message = (data as { message?: unknown } | null)?.message;
  return {
    ok: false,
    status: res.status,
    message: Array.isArray(message)
      ? message.join('; ')
      : typeof message === 'string'
        ? message
        : `Something went wrong (${res.status}). Try again.`,
    body: data,
  };
}
