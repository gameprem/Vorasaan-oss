import { API_URL, authHeaders } from '@/lib/api';

// Same-origin bridge for the Receipts export (ticket 0070): `GET /settings/ai/receipts/export`
// with the session's Bearer token, which never reaches the browser. The API checks that the
// caller is an Admin; the JSONL streams through as a download, never rendered as a page.

const PASSED_THROUGH = ['content-type', 'content-disposition'] as const;

export async function GET(request: Request) {
  const auth = await authHeaders();
  if (Object.keys(auth).length === 0) return new Response('Sign in first', { status: 401 });

  let res: Response;
  try {
    res = await fetch(`${API_URL}/settings/ai/receipts/export`, {
      headers: auth,
      signal: request.signal,
      cache: 'no-store',
    });
  } catch {
    return new Response("Can't reach the Vorasaan server", { status: 502 });
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    const status = [401, 403].includes(res.status) ? res.status : 502;
    return new Response(
      status === 403 ? 'Only an Organization Admin can export Receipts' : 'Export unavailable',
      { status, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
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
  if (!headers.has('content-disposition')) {
    headers.set('content-disposition', 'attachment; filename="vorasaan-receipts.jsonl"');
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/x-ndjson');
  return new Response(res.body, { status: 200, headers });
}
