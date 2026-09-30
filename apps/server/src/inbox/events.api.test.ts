import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, SEED_PASSWORD, seed } from '@vorasaan/db/seed';
import type {
  CreatedAccessToken,
  DecisionRequestView,
  LoginResult,
  ServerEvent,
} from '@vorasaan/shared';
import { DEV_USER_HEADER } from '../auth/identity.guard.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { EventBus } from './event-bus.ts';
import { EventsController } from './events.controller.ts';

const { pim, beam } = SEED.users;

/** Reads a live `GET /events` response message by message (comments included). */
class EventStream {
  private buffer = '';
  private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  private readonly decoder = new TextDecoder();

  constructor(
    readonly response: Response,
    private readonly abort: AbortController,
  ) {
    if (!response.body) throw new Error('no body');
    this.reader = response.body.getReader();
  }

  /** The next message: `{ comment }` for `: …` lines, else the parsed event. */
  async next(timeoutMs = 3000): Promise<{ comment: string } | ServerEvent> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (raw.startsWith(':')) return { comment: raw.slice(1).trim() };
        const field = (name: string) =>
          raw
            .split('\n')
            .find((l) => l.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        return { event: field('event'), data: JSON.parse(field('data') ?? 'null') } as ServerEvent;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for an event');
      const chunk = await Promise.race([
        this.reader.read(),
        Bun.sleep(left).then(() => ({ done: true, value: undefined, timeout: true })),
      ]);
      if ('timeout' in chunk) throw new Error('timed out waiting for an event');
      if (chunk.done) throw new Error('stream ended');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** The next real event, skipping heartbeats. */
  async nextEvent(timeoutMs = 3000): Promise<ServerEvent> {
    while (true) {
      const message = await this.next(timeoutMs);
      if ('event' in message) return message;
    }
  }

  close() {
    this.abort.abort();
  }
}

describe('GET /events (Server-Sent Events)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let base: string;
  let bus: EventBus;
  const open: EventStream[] = [];

  async function connect(headers: Record<string, string>): Promise<EventStream> {
    const abort = new AbortController();
    const response = await fetch(`${base}/events`, { headers, signal: abort.signal });
    const stream = new EventStream(response, abort);
    open.push(stream);
    return stream;
  }

  async function connectAs(userId: string) {
    const stream = await connect({ [DEV_USER_HEADER]: userId });
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toStartWith('text/event-stream');
    expect(await stream.next()).toEqual({ comment: 'connected' });
    return stream;
  }

  async function sendToPim(): Promise<DecisionRequestView> {
    const asBeam = as(app, beam.id);
    const draft = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    const sent = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.body.id}/submit`,
      { deciderRole: 'PO', recipients: 'ALL' },
    );
    return sent.body;
  }

  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condition never became true');
      await Bun.sleep(10);
    }
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    base = base.replace('[::1]', '127.0.0.1');
    bus = app.get(EventBus);
  });

  afterAll(async () => {
    for (const s of open) s.close();
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    for (const s of open.splice(0)) s.close();
    await waitFor(() => bus.listenerCount() === 0);
    await truncateAll(db);
    await seed(db);
  });

  test('refuses anonymous callers', async () => {
    const res = await fetch(`${base}/events`);
    expect(res.status).toBe(401);
  });

  test('pushes the Raiser a Notification and the Decider an Inbox change after a Decision', async () => {
    const request = await sendToPim();
    const beamStream = await connectAs(beam.id);
    const pimStream = await connectAs(pim.id);

    const decided = await as(app, pim.id)('POST', `/decision-requests/${request.id}/decision`, {
      customAnswer: 'Poll every 5 seconds',
    });
    expect(decided.status).toBe(201);

    const toBeam = await beamStream.nextEvent();
    expect(toBeam.event).toBe('notification.created');
    expect(toBeam.event === 'notification.created' && toBeam.data.notification).toMatchObject({
      type: 'REQUEST_DECIDED',
      decisionRequest: { id: request.id, status: 'DECIDED' },
      readAt: null,
    });
    expect(await pimStream.nextEvent()).toEqual({ event: 'inbox.changed', data: {} });
  });

  test('accepts a personal access token, as the CLI sends it', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: pim.email, password: SEED_PASSWORD },
    });
    const session = (login.json() as LoginResult).token;
    const pat = await app.inject({
      method: 'POST',
      url: '/me/tokens',
      headers: { authorization: `Bearer ${session}` },
      payload: { name: 'cli' },
    });
    const { token } = pat.json() as CreatedAccessToken;

    const stream = await connect({ authorization: `Bearer ${token}` });
    expect(stream.response.status).toBe(200);
    expect(await stream.next()).toEqual({ comment: 'connected' });
    await sendToPim();
    expect(await stream.nextEvent()).toEqual({ event: 'inbox.changed', data: {} });
  });

  test('a refused action pushes nothing', async () => {
    const request = await sendToPim();
    const pimStream = await connectAs(pim.id);
    // Beam withdrew it meanwhile: Pim's decide is refused.
    await db.decisionRequest.update({ where: { id: request.id }, data: { status: 'WITHDRAWN' } });
    const failed = await as(app, pim.id)('POST', `/decision-requests/${request.id}/decision`, {
      customAnswer: 'Poll every 5 seconds',
    });
    expect(failed.status).toBe(409);
    await expect(pimStream.nextEvent(300)).rejects.toThrow('timed out');
  });

  test('sends heartbeats, and forgets the listener when the client goes away', async () => {
    const controller = app.get(EventsController);
    const previous = controller.heartbeatMs;
    controller.heartbeatMs = 30;
    try {
      const stream = await connectAs(beam.id);
      expect(bus.listenerCount()).toBe(1);
      expect(await stream.next()).toEqual({ comment: 'heartbeat' });
      stream.close();
      await waitFor(() => bus.listenerCount() === 0);
    } finally {
      controller.heartbeatMs = previous;
    }
  });

  test('a Delegation that starts while connected reaches its Delegate', async () => {
    const controller = app.get(EventsController);
    const previous = controller.heartbeatMs;
    controller.heartbeatMs = 30;
    try {
      await db.teamMembership.create({
        data: { teamId: SEED.teamId, userId: beam.id, role: 'PO' },
      });
      const delegation = await db.delegation.create({
        data: {
          teamId: SEED.teamId,
          role: 'PO',
          delegatorId: pim.id,
          delegateId: beam.id,
          startsAt: new Date(Date.now() + 3_600_000),
          endsAt: new Date(Date.now() + 86_400_000),
          createdById: pim.id,
        },
      });
      const stream = await connectAs(beam.id);
      await db.delegation.update({
        where: { id: delegation.id },
        data: { startsAt: new Date(Date.now() - 1000) },
      });
      const event = await stream.nextEvent();
      expect(event.event === 'notification.created' && event.data.notification).toMatchObject({
        type: 'DELEGATION_STARTED',
        delegation: { id: delegation.id, delegator: { id: pim.id, name: 'Pim' } },
      });
    } finally {
      controller.heartbeatMs = previous;
    }
  });
});
