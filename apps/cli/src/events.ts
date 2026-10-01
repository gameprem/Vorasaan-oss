import { ServerEvent } from '@vorasaan/shared';
import { ApiError } from './api.ts';

/** One Server-Sent Events message: its `event:` name (default "message") and joined `data:` lines. */
export type SseMessage = { event: string; data: string };

/**
 * An incremental parser for the `text/event-stream` format: feed it chunks as they
 * arrive (a line or a message may be split anywhere) and it returns the complete
 * messages. Comment lines (": heartbeat") are skipped; several `data:` lines join with
 * "\n"; CRLF, CR and LF all end a line; a blank line dispatches the message.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  /** A CR ended the last chunk: a LF at the start of the next one belongs to it. */
  private pendingCr = false;

  push(chunk: string): SseMessage[] {
    let text = chunk;
    if (this.pendingCr && text.startsWith('\n')) text = text.slice(1);
    this.pendingCr = text.endsWith('\r');
    this.buffer += text;
    const messages: SseMessage[] = [];
    const lines = this.buffer.split(/\r\n|\r|\n/);
    // The last piece has no line ending yet (or is "" after a trailing one).
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const message = this.line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return undefined;
      }
      const message = { event: this.event || 'message', data: this.data.join('\n') };
      this.event = '';
      this.data = [];
      return message;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    // `id` and `retry` are not used: the client keeps its own backoff and refetches on reconnect.
    return undefined;
  }
}

/** Turns an SSE message into a typed ServerEvent; unknown or malformed ones are ignored. */
export function toServerEvent(message: SseMessage): ServerEvent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(message.data);
  } catch {
    return undefined;
  }
  const parsed = ServerEvent.safeParse({ event: message.event, data });
  return parsed.success ? parsed.data : undefined;
}

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * How long to wait before reconnect attempt `attempt` (0-based): 1 s doubling up to
 * 30 s, with "equal jitter" (half fixed, half random) so many CLIs don't reconnect in
 * step after a server restart. Never below 500 ms, so a failing server is never hammered.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (base / 2) * random());
}

export type LiveStatus =
  | { state: 'connecting' }
  | { state: 'live' }
  | { state: 'offline'; reason: string; retryInMs: number }
  /** Given up for good (sign-in rejected); the TUI keeps working without live updates. */
  | { state: 'stopped'; reason: string };

export type EventStreamOptions = {
  /** Opens the stream on the configured server (VorasaanApi.openEvents); rejects with ApiError. */
  open: (signal: AbortSignal) => Promise<Response>;
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: LiveStatus) => void;
  /** Aborting it closes the stream and ends the loop. */
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** A connection that stayed up this long resets the backoff. */
  healthyAfterMs?: number;
  /** No byte (not even a heartbeat, sent every ~25 s) for this long: assume the link is dead. */
  idleTimeoutMs?: number;
};

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

function reasonOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps `GET /events` open for as long as `signal` is not aborted: reconnects with
 * backoff after any failure or close, and stops for good on 401/403 (a rejected
 * sign-in will not fix itself by retrying). Resolves when it stops.
 */
export async function runEventStream(options: EventStreamOptions): Promise<void> {
  const {
    open,
    onEvent,
    onStatus,
    signal,
    sleep = abortableSleep,
    random = Math.random,
    now = Date.now,
    healthyAfterMs = 60_000,
    idleTimeoutMs = 70_000,
  } = options;
  let attempt = 0;

  while (!signal.aborted) {
    onStatus({ state: 'connecting' });
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener('abort', abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const watchdog = () => {
      clearTimeout(idle);
      idle = setTimeout(() => connection.abort(), idleTimeoutMs);
    };
    let connectedAt: number | undefined;
    let reason = 'The server closed the event stream';
    try {
      const res = await open(connection.signal);
      connectedAt = now();
      onStatus({ state: 'live' });
      watchdog();
      const body = res.body;
      if (!body) throw new Error('The server sent no event stream');
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          watchdog();
          for (const message of parser.push(decoder.decode(value, { stream: true }))) {
            const event = toServerEvent(message);
            if (event) onEvent(event);
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        onStatus({
          state: 'stopped',
          reason:
            error.status === 401
              ? 'Live updates stopped: your sign-in was rejected. Run `vorasaan login` again.'
              : `Live updates stopped: ${error.message}`,
        });
        return;
      }
      reason = connection.signal.aborted ? 'The event stream went silent' : reasonOf(error);
    } finally {
      clearTimeout(idle);
      signal.removeEventListener('abort', abort);
      connection.abort();
    }
    if (signal.aborted) break;
    if (connectedAt !== undefined && now() - connectedAt >= healthyAfterMs) attempt = 0;
    const retryInMs = backoffDelay(attempt, random);
    attempt++;
    onStatus({ state: 'offline', reason, retryInMs });
    await sleep(retryInMs, signal);
  }
}
