import { Readable } from 'node:stream';
import { PayloadTooLargeException } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';

// Some routes must see the request body exactly as sent, unparsed: chat app callbacks
// are signed over their raw bytes (ADR 0011), and the signature is checked before
// anything reads the body. A route marked with @VerbatimBody() gets the bytes on
// `request.verbatimBody`, and Fastify never parses it (whatever its content type, so a
// malformed or unexpected body can't fail the request before the signature check).

const VERBATIM = 'verbatimBody';
/** Chat app callbacks are small; anything bigger is refused unread. */
export const VERBATIM_BODY_LIMIT = 1024 * 1024;

/** Marks a route whose handler reads `request.verbatimBody` instead of `@Body()`. */
export const VerbatimBody = () => RouteConfig({ [VERBATIM]: true });

export type VerbatimRequest = {
  headers: Record<string, string | string[] | undefined>;
  /** The body as received; empty when there was none. */
  verbatimBody?: Buffer;
  /** Its Content-Type, kept here because the header is removed before parsing. */
  verbatimContentType?: string;
};

type HookRequest = VerbatimRequest & {
  raw: { headers: Record<string, string | string[] | undefined> };
  routeOptions?: { config?: Record<string, unknown> };
};

type PreParsingHook = (
  request: HookRequest,
  reply: unknown,
  payload: AsyncIterable<Buffer | string>,
) => Promise<AsyncIterable<Buffer | string>>;

/** Installs the hook. Call on the Fastify instance before the app registers its routes. */
export function installVerbatimBody(fastify: {
  addHook(name: 'preParsing', hook: PreParsingHook): unknown;
}): void {
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    if (request.routeOptions?.config?.[VERBATIM] !== true) return payload;
    const declared = Number(request.raw.headers['content-length']);
    if (declared > VERBATIM_BODY_LIMIT) throw new PayloadTooLargeException();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > VERBATIM_BODY_LIMIT) throw new PayloadTooLargeException();
      chunks.push(buffer);
    }
    request.verbatimBody = Buffer.concat(chunks);
    const contentType = request.raw.headers['content-type'];
    if (typeof contentType === 'string') request.verbatimContentType = contentType;
    // With no body headers left, Fastify skips its content-type parsers entirely.
    delete request.raw.headers['content-type'];
    delete request.raw.headers['content-length'];
    delete request.raw.headers['transfer-encoding'];
    return Readable.from([]);
  });
}
