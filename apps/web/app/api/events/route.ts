import { API_URL, authHeaders } from '@/lib/api';

// Same-origin bridge to the API's `GET /events` Server-Sent Events stream. A browser
// EventSource can't set headers and the session token is an httpOnly cookie, so this
// reads the cookie here, on the server, and forwards the stream with the Bearer header.
// The token never reaches the browser, and the upstream path is fixed: nothing from the
// incoming request (path, query, headers) is forwarded.

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

export async function GET(request: Request) {
  const auth = await authHeaders();
  if (Object.keys(auth).length === 0) return new Response('Not signed in', { status: 401 });

  // Aborted when the browser goes away (request.signal) or cancels the body, so the
  // API closes its end and drops the listener.
  const upstream = new AbortController();
  const abort = () => upstream.abort();
  if (request.signal.aborted) return new Response(null, { status: 499 });
  request.signal.addEventListener('abort', abort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${API_URL}/events`, {
      headers: { ...auth, accept: 'text/event-stream' },
      signal: upstream.signal,
      cache: 'no-store',
    });
  } catch {
    request.signal.removeEventListener('abort', abort);
    return new Response('Event stream unavailable', { status: 502 });
  }
  if (!res.ok || !res.body) {
    abort();
    request.signal.removeEventListener('abort', abort);
    // 401/403 pass through so the client can stop retrying; anything else is a 502.
    const status = res.status === 401 || res.status === 403 ? res.status : 502;
    return new Response('Event stream unavailable', { status });
  }

  // Pipe chunk by chunk (no buffering), and abort upstream on cancel as well as on the
  // request signal, whichever the runtime delivers first.
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          request.signal.removeEventListener('abort', abort);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch {
        // Upstream dropped or was aborted: end the browser's stream so EventSource reconnects.
        request.signal.removeEventListener('abort', abort);
        try {
          controller.close();
        } catch {
          // Already cancelled by the browser.
        }
      }
    },
    cancel() {
      request.signal.removeEventListener('abort', abort);
      abort();
      reader.cancel().catch(() => {});
    },
  });

  return new Response(body, { headers: SSE_HEADERS });
}
