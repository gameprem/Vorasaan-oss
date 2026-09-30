import { createHash, randomBytes } from 'node:crypto';

// Bearer tokens are random, prefixed by kind so they're recognizable in logs and
// secret scanners, and stored only as SHA-256 hashes.
export const SESSION_PREFIX = 'vss_';
export const PAT_PREFIX = 'vsp_';

export function newToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
