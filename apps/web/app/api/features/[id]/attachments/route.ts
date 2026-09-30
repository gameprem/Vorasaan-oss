import { API_URL, authHeaders } from '@/lib/api';
import { isId } from '@/lib/ids';

// Same-origin bridge for Attachment uploads. The browser posts multipart/form-data here;
// this forwards the body, as a stream, to `POST /features/:id/attachments` with the session's
// Bearer token, which never reaches the browser. The upstream path is fixed apart from the
// validated Feature id, and only the content type and the body are forwarded.

const MiB = 1024 * 1024;
/** Room for the multipart boundaries and the title field around the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;

/** The same limit as the API (ATTACHMENT_MAX_BYTES, default 20 MiB), plus the multipart framing. */
function maxBodyBytes() {
  const n = Number(process.env.ATTACHMENT_MAX_BYTES);
  return (Number.isSafeInteger(n) && n > 0 ? n : 20 * MiB) + MULTIPART_OVERHEAD;
}

const json = (status: number, message: string) => Response.json({ message }, { status });

/** Browsers send Origin on POST; a cross-site form must not upload with the visitor's session. */
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

/** Passes the body through, failing the stream once it grows past `limit` bytes. */
function capped(body: ReadableStream<Uint8Array>, limit: number) {
  const state = { exceeded: false };
  let seen = 0;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          state.exceeded = true;
          controller.error(new Error('Upload too large'));
        } else controller.enqueue(chunk);
      },
    }),
  );
  return { stream, state };
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isId(id)) return json(404, 'Feature not found');
  if (!sameOrigin(request)) return json(403, 'Uploads must come from this site');

  const auth = await authHeaders();
  if (Object.keys(auth).length === 0) return json(401, 'Sign in to upload');

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;') || !request.body) {
    return json(400, 'Send the file as multipart/form-data');
  }
  const limit = maxBodyBytes();
  const declared = Number(request.headers.get('content-length'));
  const tooLarge = `The file is larger than ${Math.floor((limit - MULTIPART_OVERHEAD) / MiB)} MiB`;
  if (Number.isFinite(declared) && declared > limit) return json(413, tooLarge);

  const upload = capped(request.body, limit);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/features/${id}/attachments`, {
      method: 'POST',
      headers: { ...auth, 'content-type': contentType },
      body: upload.stream,
      // Required by the fetch spec for a streamed request body.
      duplex: 'half',
      cache: 'no-store',
    } as RequestInit & { duplex: 'half' });
  } catch {
    // Either the stream was cut by the size cap or the API is down.
    return upload.state.exceeded
      ? json(413, tooLarge)
      : json(502, "Can't reach the Vorasaan server");
  }

  // Only the API's JSON (the AttachmentView or its error) goes back; nothing else is copied.
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return json(502, 'The Vorasaan server sent an unexpected reply');
  }
  return Response.json(body, { status: res.status });
}
