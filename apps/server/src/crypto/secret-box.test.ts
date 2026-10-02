import { describe, expect, test } from 'bun:test';
import { SecretBox } from './secret-box.ts';

describe('SecretBox', () => {
  const box = new SecretBox('a-very-long-test-secret-key');

  test('round-trips', () => {
    const sealed = box.encrypt('sk-ant-123');
    expect(box.decrypt(sealed)).toBe('sk-ant-123');
  });

  test('ciphertext never contains the plaintext and is randomized', () => {
    const a = box.encrypt('sk-ant-123');
    const b = box.encrypt('sk-ant-123');
    expect(a).not.toContain('sk-ant-123');
    expect(a).not.toBe(b);
  });

  test('a different key cannot decrypt', () => {
    const sealed = box.encrypt('secret');
    expect(() => new SecretBox('another-long-test-secret-key').decrypt(sealed)).toThrow();
  });

  test('tampering is detected', () => {
    const sealed = box.encrypt('secret');
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    expect(() => box.decrypt(tampered)).toThrow();
  });

  test('requires a secret', () => {
    expect(() => SecretBox.fromEnv({})).toThrow('VORASAAN_SECRET_KEY');
    expect(() => new SecretBox('short')).toThrow('at least 16');
  });
});
