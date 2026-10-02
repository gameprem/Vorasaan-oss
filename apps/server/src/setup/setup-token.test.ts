import { afterEach, describe, expect, test } from 'bun:test';
import type { PrismaClient } from '@vorasaan/db';
import { SetupTokenService } from './setup-token.service.ts';

const service = () => new SetupTokenService({} as PrismaClient);

describe('SetupTokenService', () => {
  afterEach(() => {
    delete process.env.VORASAAN_SETUP_TOKEN;
  });

  test('announces a generated token once, with a ready-made setup link', () => {
    const tokens = service();
    const token = tokens.arm() as string;
    const text = tokens.announcement('https://vorasaan.example.com/') ?? '';
    expect(text).toContain(`Setup token: ${token}`);
    expect(text).toContain(`https://vorasaan.example.com/setup?token=${token}`);
    expect(text).toContain('restart');
    // Printed once: the plain token isn't kept for a second announcement.
    expect(tokens.announcement('https://vorasaan.example.com')).toBeNull();
  });

  test('says nothing when no setup is needed', () => {
    expect(service().announcement('http://localhost:3000')).toBeNull();
  });

  test('checks tokens: right, wrong, missing, and after it is spent', () => {
    const tokens = service();
    const token = tokens.arm() as string;
    expect(tokens.check(undefined, 'a')).toBe('invalid');
    expect(tokens.check('', 'a')).toBe('invalid');
    expect(tokens.check(`${token}x`, 'a')).toBe('invalid');
    expect(tokens.check(token, 'a')).toBe('ok');
    tokens.invalidate();
    expect(tokens.check(token, 'a')).toBe('invalid');
  });

  test('limits misses per client address', () => {
    const tokens = service();
    const token = tokens.arm() as string;
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(tokens.check('guess', 'attacker', t0 + i)).toBe('invalid');
    expect(tokens.check(token, 'attacker', t0 + 20)).toBe('too-many-tries');
    expect(tokens.check(token, 'operator', t0 + 20)).toBe('ok');
    // The window passes.
    expect(tokens.check(token, 'attacker', t0 + 16 * 60_000)).toBe('ok');
  });
});
