import { describe, expect, test } from 'bun:test';
import { ActionTokens } from './action-token.ts';

const CARD = '7f0c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f50';
const CHOICE = '11111111-2222-4333-8444-555555555555';
const tokens = new ActionTokens('a-secret-key-for-vorasaan-tests');

describe('card button tokens (ticket 0058)', () => {
  test('a signed token comes back as its card and action', () => {
    expect(tokens.verify(tokens.sign(CARD, { kind: 'choice', choiceId: CHOICE }))).toEqual({
      cardId: CARD,
      action: { kind: 'choice', choiceId: CHOICE },
    });
    expect(tokens.verify(tokens.sign(CARD, { kind: 'ask' }))).toEqual({
      cardId: CARD,
      action: { kind: 'ask' },
    });
    expect(tokens.verify(tokens.sign(CARD, { kind: 'own' }))?.action).toEqual({ kind: 'own' });
  });

  test('it fits a LINE postback (300 characters) and names no person', () => {
    const token = tokens.sign(CARD, { kind: 'choice', choiceId: CHOICE });
    expect(token.length).toBeLessThanOrEqual(128);
    expect(token.split('.').slice(1, 4)).toEqual([CARD, 'c', CHOICE]);
  });

  test('an edited, truncated or foreign token is refused', () => {
    const token = tokens.sign(CARD, { kind: 'choice', choiceId: CHOICE });
    const other = '99999999-2222-4333-8444-555555555555';
    expect(tokens.verify(token.replace(CHOICE, other))).toBeNull();
    expect(tokens.verify(token.replace('.c.', '.a.'))).toBeNull();
    expect(tokens.verify(token.slice(0, -1))).toBeNull();
    expect(tokens.verify(`${token}x`)).toBeNull();
    expect(new ActionTokens('another-secret-key-entirely').verify(token)).toBeNull();
    for (const junk of ['', 'v1', 'v1.a.b.c.d', null, 42, { token }, 'x'.repeat(500)]) {
      expect(tokens.verify(junk)).toBeNull();
    }
  });
});
