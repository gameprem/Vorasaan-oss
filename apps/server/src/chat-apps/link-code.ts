import { createHash, randomInt } from 'node:crypto';

// One-time link codes (ticket 0057). Ten characters of Crockford base32: 50 random
// bits, so with codes living 10 minutes and at most a few wrong tries per chat account
// (LinkAttempts), guessing someone's code is out of reach. Shown as "ABCDE-FGHJK";
// people may type it in any case, with or without the dash or spaces, and confuse
// O with 0 or I and L with 1.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LINK_CODE_LENGTH = 10;

/** A new code for display, e.g. "7KQ2M-XD9RA". */
export function newLinkCode(): string {
  let code = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * The code in a chat message ("7KQ2M-XD9RA", "link 7kq2m xd9ra"), normalized, or null
 * when the message isn't shaped like a code.
 */
export function linkCodeIn(text: string): string | null {
  const candidate = text
    .trim()
    .toUpperCase()
    .replace(/^LINK\s+/, '')
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return candidate.length === LINK_CODE_LENGTH && [...candidate].every((c) => ALPHABET.includes(c))
    ? candidate
    : null;
}

/** Only this is stored: the code itself is shown once and never kept. */
export function hashLinkCode(normalized: string): string {
  return createHash('sha256').update(`vorasaan-chat-link:${normalized}`).digest('hex');
}

/**
 * Wrong codes per chat account: after `max` within `windowMs`, further codes from that
 * account aren't even looked up until the window passes. In memory: one server process
 * serves one Organization (as the EventBus does).
 */
export class LinkAttempts {
  private readonly failures = new Map<string, number[]>();

  constructor(
    readonly max = 5,
    readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  blocked(key: string, now: number): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now: number): void {
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()]) this.recent(k, now);
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

/**
 * Provider event ids already handled, so a redelivered or replayed callback (same
 * event, valid signature) does nothing twice. Kept for 2 hours: longer than Slack's
 * 5-minute signature window, the 1-hour age limit on LINE events, and a Bot Framework
 * token's life (about an hour, plus 5 minutes of clock skew).
 */
export class SeenEvents {
  private readonly seen = new Map<string, number>();

  constructor(readonly ttlMs = 2 * 60 * 60 * 1000) {}

  /** True the first time `key` is seen within the TTL. */
  firstTime(key: string, now: number): boolean {
    if (this.seen.size > 10_000) {
      for (const [k, at] of this.seen) if (now - at >= this.ttlMs) this.seen.delete(k);
    }
    const at = this.seen.get(key);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.set(key, now);
    return true;
  }
}
