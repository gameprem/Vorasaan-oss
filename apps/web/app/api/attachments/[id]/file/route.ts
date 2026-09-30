import { API_URL, authHeaders } from '@/lib/api';
import { isId } from '@/lib/ids';

// Same-origin bridge for downloading an Attachment's file: `GET /attachments/:id/file` with
// the session's Bearer token, which never reaches the browser. Only the validated id goes
// into the upstream path. The bytes stream through, and the API's security headers are
// kept (and set here too), so uploaded content is served as data, never as a page of this
// origin: nosniff, a sandboxing CSP and the API's Content-Disposition.

const PASSED_THROUGH = ['content-type', 'content-length', 'content-disposition'] as const;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isId(id)) return new Response('Attachment not found', { status: 404 });

  const auth = await authHeaders();
  if (Object.keys(auth).length === 0) return new Response('Sign in first', { status: 401 });

  let res: Response;
  try {
    res = await fetch(`${API_URL}/attachments/${id}/file`, {
      headers: auth,
      signal: request.signal,
      cache: 'no-store',
    });
  } catch {
    return new Response("Can't reach the Vorasaan server", { status: 502 });
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    const status = [401, 403, 404].includes(res.status) ? res.status : 502;
    return new Response(status === 404 ? 'Attachment not found' : 'Download unavailable', {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const headers = new Headers({
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-store',
  });
  for (const name of PASSED_THROUGH) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Without the API's disposition, never let a browser render it inline.
  if (!headers.has('content-disposition')) headers.set('content-disposition', 'attachment');
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
  return new Response(res.body, { status: 200, headers });
}
