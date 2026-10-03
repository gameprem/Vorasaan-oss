import { API_URL, authHeaders } from './api';

/** A Zod schema from `@vorasaan/shared`, as far as this file needs one. */
type BodySchema = {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: { message: string }[] } };
};

// Same-origin JSON bridge for the chat view (ticket 0046): the browser posts to
// `app/api/conversations/...` and `app/api/action-cards/...`, and this forwards the call to
// the API with the session's Bearer token, which never reaches the browser.
//
// The chat calls go through route handlers instead of Server Actions because the client
// runs Server Actions one at a time: a Stop pressed while a reply streams would wait for
// that reply to finish. Each route fixes its upstream path (ids are checked as UUIDs) and
// the body is parsed with the API's own Zod schema, so nothing else is forwarded.

const json = (status: number, message: string) => Response.json({ message }, { status });

/** Browsers send Origin on POST; a cross-site page must not act with the visitor's session. */
function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Forwards one POST to `path` on the API. With a `schema`, the browser's JSON body must
 * match it (an empty body counts as `undefined`); without one, no body is sent.
 */
export async function forwardPost(request: Request, path: string, schema?: BodySchema) {
  if (!sameOrigin(request)) return json(403, 'Requests must come from this site');
  const auth = await authHeaders();
  if (Object.keys(auth).length === 0) return json(401, 'Your session expired. Sign in again.');

  let body: unknown;
  if (schema) {
    let raw: unknown;
    try {
      const text = await request.text();
      raw = text ? JSON.parse(text) : undefined;
    } catch {
      return json(400, 'Send the request as JSON');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return json(400, parsed.error.issues[0]?.message ?? 'The request is not valid');
    }
    body = parsed.data;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // The browser going away (a closed tab) doesn't stop the reply; Stop does.
      cache: 'no-store',
    });
  } catch {
    return json(502, "Can't reach the Vorasaan server");
  }

  if (res.status === 204) return new Response(null, { status: 204 });
  // Only the API's JSON (the view or its error) goes back; nothing else is copied.
  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return json(502, 'The Vorasaan server sent an unexpected reply');
  }
  return Response.json(payload, { status: res.status });
}

/** Forwards one GET to `path` on the API, with the session; only its JSON comes back. */
export async function forwardGet(path: string) {
  const auth = await authHeaders();
  if (Object.keys(auth).length === 0) return json(401, 'Your session expired. Sign in again.');
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { headers: auth, cache: 'no-store' });
  } catch {
    return json(502, "Can't reach the Vorasaan server");
  }
  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return json(502, 'The Vorasaan server sent an unexpected reply');
  }
  return Response.json(payload, { status: res.status });
}
