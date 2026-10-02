import type { LoginResult } from '@vorasaan/shared';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from './api';

// Not a server action: only other server code (login, setup) may set the session.
export async function setSession(result: LoginResult) {
  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure:
      process.env.NODE_ENV === 'production' && process.env.VORASAAN_INSECURE_COOKIES !== 'true',
    path: '/',
    expires: new Date(result.expiresAt),
  });
}
