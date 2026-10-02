import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import { LinkAttempts } from '../chat-apps/link-code.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

/** An operator-chosen VORASAAN_SETUP_TOKEN must be at least this long. */
export const SETUP_TOKEN_MIN_LENGTH = 20;
/** Wrong tokens allowed per client address in the window, before it must wait. */
const MAX_MISSES = 10;
const MISS_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export type SetupTokenCheck = 'ok' | 'invalid' | 'too-many-tries';

/**
 * The Setup Token (ticket 0062): a one-time secret that first-run setup requires, so
 * whoever reaches a fresh, internet-exposed install first can't claim the Admin account.
 *
 * While no Organization exists, startup arms a token: VORASAAN_SETUP_TOKEN if the
 * operator set one, else 192 random bits, new on every start. Only its SHA-256 lives on
 * in memory; a generated token is printed once (`announcement()`, from main.ts) and then
 * forgotten. Completing setup spends it. Several server instances need the env token,
 * since each process generates its own.
 */
@Injectable()
export class SetupTokenService implements OnApplicationBootstrap {
  private hash: Buffer | null = null;
  /** A generated token waiting for its one print, or 'env' for a configured one. */
  private pending: string | 'env' | null = null;
  /**
   * Misses per client address, in memory. Behind the web app every attempt comes from the
   * web server's address, so a flood of wrong tokens can pause setup there for the window;
   * a restart (new token) clears it. The token's entropy is the real protection.
   */
  private attempts = new LinkAttempts(MAX_MISSES, MISS_WINDOW_MS);

  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  async onApplicationBootstrap() {
    // If the database can't say yet, arm anyway: the guard still refuses (409) once an
    // Organization exists, and setup works when the database comes back.
    const organizations = await this.db.organization.count().catch(() => 0);
    if (organizations === 0) this.arm();
  }

  /**
   * Arms a Setup Token: the configured one, or a fresh random one, which it returns
   * (null for a configured token). Forgets any earlier token and its misses.
   */
  arm(): string | null {
    this.attempts = new LinkAttempts(MAX_MISSES, MISS_WINDOW_MS);
    const configured = process.env.VORASAAN_SETUP_TOKEN?.trim();
    if (configured) {
      if (configured.length < SETUP_TOKEN_MIN_LENGTH) {
        throw new Error(
          `VORASAAN_SETUP_TOKEN must be at least ${SETUP_TOKEN_MIN_LENGTH} characters. Generate one: openssl rand -base64 24`,
        );
      }
      this.hash = sha256(configured);
      this.pending = 'env';
      return null;
    }
    const token = randomBytes(24).toString('base64url');
    this.hash = sha256(token);
    this.pending = token;
    return token;
  }

  /**
   * What to print at startup while setup is needed, once: the generated token and a
   * ready-made link, or a pointer to VORASAAN_SETUP_TOKEN. Null when there's nothing to say.
   */
  announcement(webUrl: string): string | null {
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.hash) return null;
    const setupUrl = `${webUrl.replace(/\/+$/, '')}/setup`;
    const rule = '='.repeat(72);
    const lines =
      pending === 'env'
        ? [
            'Vorasaan needs first-run setup.',
            `Open ${setupUrl} and enter the setup token from VORASAAN_SETUP_TOKEN.`,
          ]
        : [
            'Vorasaan needs first-run setup. Only someone with this token can do it.',
            '',
            `  Setup token: ${pending}`,
            `  Open:        ${setupUrl}?token=${pending}`,
            '',
            'It works once, and a new one is printed each time the server restarts',
            'until setup is done.',
          ];
    return ['', rule, ...lines, rule, ''].join('\n');
  }

  /** Checks a presented token, in constant time, counting misses per client address. */
  check(candidate: string | undefined, client: string, now = Date.now()): SetupTokenCheck {
    if (this.attempts.blocked(client, now)) return 'too-many-tries';
    const ok =
      this.hash !== null &&
      candidate !== undefined &&
      timingSafeEqual(sha256(candidate), this.hash);
    if (!ok) {
      this.attempts.fail(client, now);
      return 'invalid';
    }
    return 'ok';
  }

  /** Setup is done: no token opens it again until a restart finds it needed. */
  invalidate(): void {
    this.hash = null;
    this.pending = null;
  }
}
