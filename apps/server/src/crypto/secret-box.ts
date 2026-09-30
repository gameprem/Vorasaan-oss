import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM for secrets at rest (LLM keys, Atlassian tokens).
// Format: "v1:" + base64(iv[12] | tag[16] | ciphertext). The key is derived from
// VORASAAN_SECRET_KEY with SHA-256, so any sufficiently random string works.

const VERSION = 'v1:';

export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) {
      throw new Error(
        'VORASAAN_SECRET_KEY must be at least 16 characters (use: openssl rand -base64 32)',
      );
    }
    this.key = createHash('sha256').update(secret).digest();
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): SecretBox {
    const secret = env.VORASAAN_SECRET_KEY;
    if (!secret) {
      throw new Error('VORASAAN_SECRET_KEY is not set. Generate one with: openssl rand -base64 32');
    }
    return new SecretBox(secret);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  decrypt(sealed: string): string {
    if (!sealed.startsWith(VERSION)) throw new Error('Unknown secret format');
    const raw = Buffer.from(sealed.slice(VERSION.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}
