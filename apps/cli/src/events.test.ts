import { describe, expect, test } from 'bun:test';
import type { ServerEvent } from '@vorasaan/shared';
import { ApiError } from './api.ts';
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  type LiveStatus,
  runEventStream,
  SseParser,
  toServerEvent,
} from './events.ts';

describe('SseParser', () => {
  test('parses named events, skips comments and joins multi-line data', () => {
    const parser = new SseParser();
    expect(
      parser.push(
        ': connected\n\nevent: inbox.changed\ndata: {}\n\n: heartbeat\n\ndata: line 1\ndata:line 2\n\n',
      ),
    ).toEqual([
      { event: 'inbox.changed', data: '{}' },
      { event: 'message', data: 'line 1\nline 2' },
    ]);
  });

  test('keeps partial lines and messages across chunks, whatever the split', () => {
    const stream = 'event: inbox.changed\r\ndata: {"a":1}\r\n\r\nevent: x\rdata: 2\r\r';
    for (let size = 1; size <= stream.length; size++) {
      const parser = new SseParser();
      const out = [];
      for (let i = 0; i < stream.length; i += size)
        out.push(...parser.push(stream.slice(i, i + size)));
      expect(out).toEqual([
        { event: 'inbox.changed', data: '{"a":1}' },
        { event: 'x', data: '2' },
      ]);
    }
  });

  test('a message without data is dropped, and the event name does not leak to the next', () => {
    const parser = new SseParser();
    expect(parser.push('event: lonely\n\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  test('toServerEvent accepts the known events and ignores anything else', () => {
    expect(toServerEvent({ event: 'inbox.changed', data: '{}' })).toEqual({
      event: 'inbox.changed',
      data: {},
    });
    expect(toServerEvent({ event: 'inbox.changed', data: 'not json' })).toBeUndefined();
    expect(toServerEvent({ event: 'something.else', data: '{}' })).toBeUndefined();
    expect(toServerEvent({ event: 'notification.created', data: '{}' })).toBeUndefined();
  });
});

describe('backoffDelay', () => {
  test('doubles from 1 s up to 30 s with jitter in [half, full]', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(3, () => 0)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(20, () => 0)).toBe(BACKOFF_MAX_MS / 2);
  });
});

/** A streaming response that sends `chunks` and then ends (or stays open). */
function sse(chunks: string[], { end = true } = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (end) controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

type Step = Response | Error | ((signal: AbortSignal) => Promise<Response>);

/** Drives runEventStream with scripted connections and a fake clock; no network, no waiting. */
function harness(steps: Step[], { abortAfter = steps.length } = {}) {
  const controller = new AbortController();
  const statuses: LiveStatus[] = [];
  const events: ServerEvent[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let opened = 0;
  const done = runEventStream({
    signal: controller.signal,
    random: () => 1,
    now: () => clock,
    open: async (signal) => {
      const step = steps[opened++];
      if (opened > abortAfter || !step) {
        controller.abort();
        throw new Error('aborted');
      }
      if (step instanceof Error) throw step;
      if (typeof step === 'function') return step(signal);
      return step;
    },
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return {
    done,
    statuses,
    events,
    sleeps,
    controller,
    advance: (ms: number) => {
      clock += ms;
    },
    opened: () => opened,
  };
}

describe('runEventStream', () => {
  test('delivers events, then reconnects with growing backoff after failures', async () => {
    const down = new ApiError(0, 'Cannot reach the Vorasaan server at http://api.test');
    const h = harness([
      sse([': connected\n\n', 'event: inbox.changed\ndata: {}\n\n']),
      down,
      down,
      down,
    ]);
    await h.done;
    expect(h.events).toEqual([{ event: 'inbox.changed', data: {} }]);
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(h.statuses.slice(0, 4)).toEqual([
      { state: 'connecting' },
      { state: 'live' },
      { state: 'offline', reason: 'The server closed the event stream', retryInMs: 1000 },
      { state: 'connecting' },
    ]);
    expect(h.statuses).toContainEqual({
      state: 'offline',
      reason: 'Cannot reach the Vorasaan server at http://api.test',
      retryInMs: 2000,
    });
  });

  test('a server that accepts then drops at once never causes a hot loop', async () => {
    const h = harness(Array.from({ length: 8 }, () => sse([])));
    await h.done;
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test('a connection that stayed healthy resets the backoff', async () => {
    const down = new Error('socket hang up');
    let h: ReturnType<typeof harness>;
    // Stays connected for 61 s (on the fake clock), then the server restarts.
    const healthy = async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              h.advance(61_000);
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    h = harness([down, down, down, healthy, down]);
    await h.done;
    expect(h.sleeps).toEqual([1000, 2000, 4000, 1000, 2000]);
  });

  test('stops for good on 401 and on 403, with a clear message', async () => {
    const h401 = harness([new ApiError(401, 'Unauthorized'), sse([])]);
    await h401.done;
    expect(h401.opened()).toBe(1);
    expect(h401.sleeps).toEqual([]);
    expect(h401.statuses.at(-1)).toEqual({
      state: 'stopped',
      reason: 'Live updates stopped: your sign-in was rejected. Run `vorasaan login` again.',
    });

    const h403 = harness([new ApiError(403, 'Forbidden resource')]);
    await h403.done;
    expect(h403.statuses.at(-1)).toEqual({
      state: 'stopped',
      reason: 'Live updates stopped: Forbidden resource',
    });
  });

  test('aborting closes an open stream and ends the loop without reconnecting', async () => {
    let streamSignal: AbortSignal | undefined;
    const h = harness([
      async (signal) => {
        streamSignal = signal;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('event: inbox.changed\ndata: {}\n\n'));
              signal.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    ]);
    while (h.events.length === 0) await Bun.sleep(1);
    h.controller.abort();
    await h.done;
    expect(streamSignal?.aborted).toBe(true);
    expect(h.sleeps).toEqual([]);
    expect(h.statuses.at(-1)).toEqual({ state: 'live' });
  });

  test('a silent stream (no heartbeat) is dropped and reconnected', async () => {
    const controller = new AbortController();
    const statuses: LiveStatus[] = [];
    let opened = 0;
    await runEventStream({
      signal: controller.signal,
      idleTimeoutMs: 20,
      random: () => 1,
      open: async (signal) => {
        opened++;
        if (opened > 1) {
          controller.abort();
          throw new Error('aborted');
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              signal.addEventListener('abort', () => c.error(new Error('aborted')));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      sleep: async () => {},
    });
    expect(statuses).toContainEqual({
      state: 'offline',
      reason: 'The event stream went silent',
      retryInMs: 1000,
    });
  });
});
