import { describe, expect, test } from 'bun:test';
import { parseRaiseFlags, UsageError } from './raise-options.ts';

describe('parseRaiseFlags', () => {
  test('normalizes kind and decider role', () => {
    expect(parseRaiseFlags({ kind: 'question', deciderRole: 'tech-lead' })).toMatchObject({
      kind: 'QUESTION',
      deciderRole: 'TECH_LEAD',
      withChoices: true,
      yes: false,
    });
  });

  test('rejects unknown kind and role', () => {
    expect(() => parseRaiseFlags({ kind: 'issue' })).toThrow(UsageError);
    expect(() => parseRaiseFlags({ deciderRole: 'ceo' })).toThrow('--decider-role');
  });

  test('--yes needs feature, title and description', () => {
    expect(() => parseRaiseFlags({ yes: true, title: 't' })).toThrow(
      '--yes needs --feature, --description',
    );
    expect(parseRaiseFlags({ yes: true, feature: 'f', title: 't', description: 'd' }).yes).toBe(
      true,
    );
  });

  test('--no-choices only for questions', () => {
    expect(parseRaiseFlags({ kind: 'question', choices: false }).withChoices).toBe(false);
    expect(() => parseRaiseFlags({ kind: 'blocker', choices: false })).toThrow('--no-choices');
  });
});
