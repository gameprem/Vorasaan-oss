import { describe, expect, test } from 'bun:test';
import type { InboxItem, ResponseWindowState } from '@vorasaan/shared';
import { id, NO_WINDOW, request } from './fixtures.ts';
import { inboxItemDetail, inboxItemKey, inboxItemLine, requestLine } from './format.ts';

const now = new Date('2026-10-05T10:00:00Z');
const item = (responseWindow: ResponseWindowState) =>
  ({
    kind: 'CLAIM',
    feature: { id: id(101), title: 'Async checkout' },
    since: now.toISOString(),
    decisionRequest: {
      id: id(301),
      title: 'Provider has no webhook',
      kind: 'BLOCKER',
      raiser: { id: id(1), name: 'Beam' },
      deciderRole: 'PO',
      onBehalfOf: null,
      responseWindow,
    },
  }) as InboxItem;

describe('Response Window labels in the TUI (ticket 0055)', () => {
  test('Inbox Items show "due in", "overdue" and "escalated"', () => {
    expect(
      inboxItemLine(
        item({ dueAt: '2026-10-05T12:00:00.000Z', paused: false, escalationStep: 0 }),
        now,
      ),
    ).toBe('Claim Blocker: Provider has no webhook · Async checkout (PO) · due in 2h');
    expect(
      inboxItemLine(
        item({ dueAt: '2026-10-05T09:00:00.000Z', paused: false, escalationStep: 1 }),
        now,
      ),
    ).toBe('Claim Blocker: Provider has no webhook · Async checkout (PO) · overdue 1h');
    expect(
      inboxItemLine(
        item({ dueAt: '2026-10-05T07:00:00.000Z', paused: false, escalationStep: 2 }),
        now,
      ),
    ).toBe('Claim Blocker: Provider has no webhook · Async checkout (PO) · overdue 3h · escalated');
    expect(inboxItemLine(item(NO_WINDOW), now)).toBe(
      'Claim Blocker: Provider has no webhook · Async checkout (PO)',
    );
  });

  test('My Requests shows them while OPEN only', () => {
    const responseWindow = { dueAt: '2026-10-05T09:00:00.000Z', paused: false, escalationStep: 3 };
    expect(requestLine(request({ responseWindow }), now)).toBe(
      '[Open] Blocker: Provider has no webhook · Async checkout · overdue 1h · escalated',
    );
    expect(requestLine(request({ responseWindow, status: 'DECIDED' }), now)).toBe(
      '[Decided] Blocker: Provider has no webhook · Async checkout',
    );
    expect(
      requestLine(
        request({ responseWindow: { ...responseWindow, paused: true }, status: 'NEEDS_INFO' }),
        now,
      ),
    ).toBe('[Needs info] Blocker: Provider has no webhook · Async checkout');
  });
});

describe('Design Docs in the TUI Inbox (ticket 0069)', () => {
  test('an approver sees which Design Doc waits, and that it is reviewed in the web app', () => {
    const designDoc = (reason: 'FIRST_DRAFT' | 'SPEC_CHANGED') =>
      ({
        kind: 'APPROVE_DESIGN_DOC',
        feature: { id: id(101), title: 'Async checkout' },
        since: now.toISOString(),
        designDoc: { proposalId: id(401), key: id(21), name: 'Back-End', reason },
      }) as InboxItem;
    expect(inboxItemLine(designDoc('FIRST_DRAFT'))).toBe(
      'Approve Back-End Design Doc · Async checkout',
    );
    expect(inboxItemLine(designDoc('SPEC_CHANGED'))).toBe(
      'Approve Back-End Design Doc update · Async checkout',
    );
    expect(inboxItemKey(designDoc('FIRST_DRAFT'))).toBe(`design-doc:${id(401)}`);
    expect(inboxItemDetail(designDoc('SPEC_CHANGED'))[1]).toContain('web app');
  });
});
