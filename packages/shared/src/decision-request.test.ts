import { describe, expect, test } from 'bun:test';
import {
  ChoiceDraft,
  DecideInput,
  ListDecisionRequestsQuery,
  PostRequestMessageInput,
  RaiseDecisionRequestInput,
  ReassignInput,
  SubmitDecisionRequestInput,
} from './decision-request.ts';

const choice = (label: string): ChoiceDraft => ({
  label,
  title: `Option ${label}`,
  description: 'Do the thing.',
  impactScope: 'Small',
  impactTime: '+1 day',
  impactRisk: 'Low',
});

const uuid = '00000000-0000-4000-8000-000000000001';

describe('RaiseDecisionRequestInput', () => {
  test('defaults withChoices to true', () => {
    const parsed = RaiseDecisionRequestInput.parse({
      featureId: uuid,
      kind: 'BLOCKER',
      title: 'Provider API too slow',
      description: 'Sync call takes 8s.',
    });
    expect(parsed.withChoices).toBe(true);
  });

  test('rejects an unknown kind and a blank title', () => {
    expect(
      RaiseDecisionRequestInput.safeParse({
        featureId: uuid,
        kind: 'ISSUE',
        title: 'x',
        description: 'y',
      }).success,
    ).toBe(false);
    expect(
      RaiseDecisionRequestInput.safeParse({
        featureId: uuid,
        kind: 'QUESTION',
        title: '   ',
        description: 'y',
      }).success,
    ).toBe(false);
  });
});

describe('SubmitDecisionRequestInput', () => {
  test('accepts 2 to 4 choices', () => {
    for (const n of [2, 3, 4]) {
      const choices = ['A', 'B', 'C', 'D'].slice(0, n).map(choice);
      expect(SubmitDecisionRequestInput.safeParse({ deciderRole: 'PO', choices }).success).toBe(
        true,
      );
    }
  });

  test('rejects 1 or 5 choices', () => {
    for (const labels of [['A'], ['A', 'B', 'C', 'D', 'E']]) {
      expect(
        SubmitDecisionRequestInput.safeParse({ deciderRole: 'PO', choices: labels.map(choice) })
          .success,
      ).toBe(false);
    }
  });

  test('rejects an unknown role', () => {
    expect(SubmitDecisionRequestInput.safeParse({ deciderRole: 'CEO' }).success).toBe(false);
  });

  test('recipients is ALL or one person, and defaults to ALL', () => {
    expect(SubmitDecisionRequestInput.parse({ deciderRole: 'PO' }).recipients).toBe('ALL');
    expect(
      SubmitDecisionRequestInput.parse({ deciderRole: 'PO', recipients: { userId: uuid } })
        .recipients,
    ).toEqual({ userId: uuid });
    for (const recipients of ['SOME', { userId: 'nope' }, [uuid]]) {
      expect(SubmitDecisionRequestInput.safeParse({ deciderRole: 'PO', recipients }).success).toBe(
        false,
      );
    }
  });
});

describe('ReassignInput and ListDecisionRequestsQuery', () => {
  test('reassign needs a user id', () => {
    expect(ReassignInput.safeParse({ userId: uuid }).success).toBe(true);
    expect(ReassignInput.safeParse({}).success).toBe(false);
  });

  test('recipient=me is a valid filter', () => {
    expect(ListDecisionRequestsQuery.parse({ recipient: 'me' })).toEqual({ recipient: 'me' });
    expect(ListDecisionRequestsQuery.safeParse({ recipient: 'you' }).success).toBe(false);
  });
});

describe('PostRequestMessageInput', () => {
  test('needs a known kind and a non-blank body', () => {
    for (const kind of ['QUESTION', 'ANSWER', 'NOTE']) {
      expect(PostRequestMessageInput.safeParse({ kind, body: 'Which provider?' }).success).toBe(
        true,
      );
    }
    expect(PostRequestMessageInput.parse({ kind: 'NOTE', body: '  trimmed  ' }).body).toBe(
      'trimmed',
    );
    expect(PostRequestMessageInput.safeParse({ kind: 'NOTE', body: '   ' }).success).toBe(false);
    expect(PostRequestMessageInput.safeParse({ kind: 'REPLY', body: 'Hi' }).success).toBe(false);
    expect(PostRequestMessageInput.safeParse({ body: 'Hi' }).success).toBe(false);
  });

  test('caps the body at 10,000 characters and rejects unknown keys', () => {
    expect(
      PostRequestMessageInput.safeParse({ kind: 'NOTE', body: 'x'.repeat(10_000) }).success,
    ).toBe(true);
    expect(
      PostRequestMessageInput.safeParse({ kind: 'NOTE', body: 'x'.repeat(10_001) }).success,
    ).toBe(false);
    expect(
      PostRequestMessageInput.safeParse({ kind: 'NOTE', body: 'Hi', authorId: 'x' }).success,
    ).toBe(false);
  });
});

describe('DecideInput', () => {
  test('accepts a choice or a custom answer', () => {
    expect(DecideInput.safeParse({ choiceId: uuid }).success).toBe(true);
    expect(DecideInput.safeParse({ customAnswer: 'Ship it behind a flag' }).success).toBe(true);
    expect(DecideInput.safeParse({ choiceId: uuid, rationale: 'Cheapest' }).success).toBe(true);
  });

  test('rejects both or neither', () => {
    expect(DecideInput.safeParse({ choiceId: uuid, customAnswer: 'Also this' }).success).toBe(
      false,
    );
    expect(DecideInput.safeParse({}).success).toBe(false);
    expect(DecideInput.safeParse({ rationale: 'Just because' }).success).toBe(false);
  });
});
