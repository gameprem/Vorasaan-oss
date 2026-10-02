import { describe, expect, test } from 'bun:test';
import { hashLinkCode, LinkAttempts, linkCodeIn, newLinkCode, SeenEvents } from './link-code.ts';

describe('link codes', () => {
  test('ten Crockford base32 characters, shown in two groups, different every time', () => {
    const codes = new Set(Array.from({ length: 200 }, newLinkCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  test('read from a message however it was typed', () => {
    expect(linkCodeIn('7KQ2M-XD9RA')).toBe('7KQ2MXD9RA');
    expect(linkCodeIn('  7kq2m xd9ra ')).toBe('7KQ2MXD9RA');
    expect(linkCodeIn('link 7kq2m-xd9ra')).toBe('7KQ2MXD9RA');
    // O for 0, I and L for 1.
    expect(linkCodeIn('OKQ2M-XDIRL')).toBe('0KQ2MXD1R1');
  });

  test('not a code', () => {
    expect(linkCodeIn('unlink')).toBeNull();
    expect(linkCodeIn('hello')).toBeNull();
    expect(linkCodeIn('7KQ2M-XD9R')).toBeNull();
    expect(linkCodeIn('7KQ2M-XD9RAA')).toBeNull();
    expect(linkCodeIn('7KQ2M-XD9RU')).toBeNull(); // U is not in the alphabet
  });

  test('the stored hash is not the code', () => {
    expect(hashLinkCode('7KQ2MXD9RA')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkCode('7KQ2MXD9RA')).not.toBe(hashLinkCode('7KQ2MXD9RB'));
  });

  test('5 wrong codes per chat account per 15 minutes', () => {
    const attempts = new LinkAttempts();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(attempts.blocked('LINE:U1', t0 + i)).toBe(false);
      attempts.fail('LINE:U1', t0 + i);
    }
    expect(attempts.blocked('LINE:U1', t0 + 10)).toBe(true);
    expect(attempts.blocked('LINE:U2', t0 + 10)).toBe(false);
    expect(attempts.blocked('LINE:U1', t0 + 15 * 60_000 + 5)).toBe(false);
  });

  test('an event id is handled once within 2 hours', () => {
    const seen = new SeenEvents();
    expect(seen.firstTime('LINE:e1', 0)).toBe(true);
    expect(seen.firstTime('LINE:e1', 1000)).toBe(false);
    expect(seen.firstTime('SLACK:e1', 1000)).toBe(true);
    expect(seen.firstTime('LINE:e1', 60 * 60_000 + 1)).toBe(false);
    expect(seen.firstTime('LINE:e1', 2 * 60 * 60_000 + 1)).toBe(true);
  });
});
