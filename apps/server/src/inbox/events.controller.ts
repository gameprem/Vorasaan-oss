import type { ServerResponse } from 'node:http';
import { Controller, Get, type OnModuleDestroy, Res } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { AuthService } from '../auth/auth.service.ts';
import { CurrentToken, CurrentUser } from '../auth/identity.guard.ts';
import { EventBus } from './event-bus.ts';
import { NotificationsService } from './notifications.service.ts';

type RawReply = { hijack(): void; raw: ServerResponse };

/**
 * `GET /events`: a Server-Sent Events stream of `inbox.changed` and
 * `notification.created` for the signed-in user.
 *
 * It uses the API's normal auth (IdentityGuard): `Authorization: Bearer` with a session
 * token or a personal access token (the CLI). A browser EventSource cannot set headers,
 * and the web's session token lives in an httpOnly cookie on the web origin, so the web
 * reaches this through a same-origin Next.js route that reads the cookie and forwards
 * the stream with the Bearer header, as `lib/api.ts` does for every other call.
 */
@Controller('events')
export class EventsController implements OnModuleDestroy {
  /** Comment lines keep proxies from closing an idle stream. */
  heartbeatMs = 25_000;
  /** Closers of the open streams, so shutdown doesn't wait on them. */
  private readonly open = new Set<() => void>();

  constructor(
    private readonly bus: EventBus,
    private readonly notifications: NotificationsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  stream(
    @CurrentUser() user: User,
    @CurrentToken() token: string | undefined,
    @Res() reply: RawReply,
  ) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (chunk: string) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    };
    write(': connected\n\n');

    const unsubscribe = this.bus.subscribe(user.id, (e) =>
      write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`),
    );
    // Delegations that start later are noticed here, so a connected client hears of them.
    const catchUp = () => {
      this.notifications.startDelegations(user.id).catch(() => {});
    };
    // A stream outlives the request that authenticated it, so each heartbeat re-checks the
    // session or Personal Access Token and ends the stream once it is revoked or expired.
    // (Dev-auth streams have no token to re-check.) A failed check (e.g. a database blip)
    // keeps the stream and tries again on the next heartbeat.
    let checking = false;
    const recheck = async () => {
      if (!token || checking) return;
      checking = true;
      try {
        if (!(await this.auth.tokenIsLive(token, user.id))) close();
      } catch {
        // Try again on the next heartbeat.
      } finally {
        checking = false;
      }
    };
    const heartbeat = setInterval(() => {
      void recheck().then(() => {
        if (closed) return;
        write(': heartbeat\n\n');
        catchUp();
      });
    }, this.heartbeatMs);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.open.delete(close);
      if (!res.writableEnded) res.end();
    };
    this.open.add(close);
    // Fires when the client goes away (or the response ends).
    res.on('close', close);
    res.on('error', close);
    catchUp();
  }

  onModuleDestroy() {
    for (const close of [...this.open]) close();
  }
}
