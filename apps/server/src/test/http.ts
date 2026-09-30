import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEV_USER_HEADER } from '../dev-identity/dev-user.guard.ts';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** `app.inject` bound to a user, returning status + parsed JSON. */
export function as(app: NestFastifyApplication, userId: string) {
  return async <T = unknown>(method: Method, url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { [DEV_USER_HEADER]: userId },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };
}
