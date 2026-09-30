import { describe, expect, test } from 'bun:test';
import { CreateDelegationInput } from './delegation.ts';

const uuid = '00000000-0000-4000-8000-000000000001';

describe('CreateDelegationInput', () => {
  const base = { delegateId: uuid, role: 'PO', startsAt: '2026-10-01T00:00:00Z' };

  test('accepts a range with any offset and leaves the delegator to default to the caller', () => {
    const parsed = CreateDelegationInput.parse({ ...base, endsAt: '2026-10-08T00:00:00+07:00' });
    expect(parsed.delegatorId).toBeUndefined();
  });

  test('rejects an end that is not after the start, and an unknown role', () => {
    expect(CreateDelegationInput.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
    expect(
      CreateDelegationInput.safeParse({ ...base, role: 'BOSS', endsAt: '2026-10-08T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});
