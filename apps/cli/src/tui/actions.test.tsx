import { afterEach, describe, expect, test } from 'bun:test';
import type { DecisionRequestView, InboxItem, ServerEvent } from '@vorasaan/shared';
import { cleanup, render } from 'ink-testing-library';
import type { LiveStatus } from '../events.ts';
import { App, type LiveFeed, type TuiRepo } from './App.tsx';
import {
  BRIEF_PROPOSAL_ID,
  type FakeOptions,
  fakeApi,
  id,
  ME,
  NO_WINDOW,
  notifications,
  PROJECT_A,
  request,
  SPEC_PROPOSAL_ID,
  specProposal,
} from './fixtures.ts';
import { KEY, press, settle, waitFor } from './test-helpers.ts';

const repo: TuiRepo = { root: '/repo', cwd: '/repo' };
const at = '2026-09-30T10:00:00.000Z';
const feature = { id: id(101), title: 'Async checkout' };
const fah = { id: id(3), name: 'Fah' };

const toDecide = request({
  id: id(302),
  kind: 'QUESTION',
  title: 'Which retry policy?',
  raiser: fah,
  decider: ME,
  recipients: [ME],
});
const toClaim = request({
  id: id(303),
  title: 'Which provider?',
  raiser: fah,
  decider: null,
  recipients: [ME, { id: id(5), name: 'Nok' }],
  canClaim: true,
});
const needsInfo = request({ id: id(301), status: 'NEEDS_INFO' });

const ref = (r: DecisionRequestView) => ({ id: r.id, title: r.title, kind: r.kind });
const items: InboxItem[] = [
  {
    kind: 'DECIDE',
    feature,
    since: at,
    decisionRequest: {
      ...ref(toDecide),
      raiser: fah,
      deciderRole: 'PO',
      onBehalfOf: null,
      responseWindow: NO_WINDOW,
    },
  },
  {
    kind: 'CLAIM',
    feature,
    since: at,
    decisionRequest: {
      ...ref(toClaim),
      raiser: fah,
      deciderRole: 'PO',
      onBehalfOf: null,
      responseWindow: NO_WINDOW,
    },
  },
  {
    kind: 'ANSWER',
    feature,
    since: at,
    decisionRequest: { ...ref(needsInfo), decider: { id: id(2), name: 'Pim' } },
    question: 'Which provider?',
  },
  {
    kind: 'APPROVE_PROPOSAL',
    feature,
    since: at,
    specProposal: { id: SPEC_PROPOSAL_ID, source: 'DECISION', decisionRequest: ref(needsInfo) },
  },
  {
    kind: 'APPROVE_BRIEF_PROPOSAL',
    project: { id: PROJECT_A, name: 'Mobile Banking' },
    since: at,
    briefProposal: { id: BRIEF_PROPOSAL_ID, source: 'GRILLING' },
  },
];

function open(options: FakeOptions = {}, extra: { live?: LiveFeed } = {}) {
  const fake = fakeApi({
    inbox: items,
    requests: { [toDecide.id]: toDecide, [toClaim.id]: toClaim, [needsInfo.id]: needsInfo },
    ...options,
  });
  const notified: [string, string][] = [];
  const notifier = {
    notify: (t: string, b: string) => notified.push([t, b]),
    disabledReason: undefined,
  };
  const ui = render(
    <App api={fake.api} repo={repo} height={14} notifier={notifier} live={extra.live} />,
  );
  return { ...fake, ...ui, notified, frame: () => ui.lastFrame() ?? '' };
}

/** Opens the n-th Inbox Item (0-based). */
async function openItem(
  ui: { stdin: { write: (s: string) => void }; frame: () => string },
  index: number,
  waitText: string,
) {
  await waitFor(ui.frame, 'Inbox Items (5)');
  await press(ui.stdin, ...Array<string>(index).fill('j'), KEY.enter);
  await waitFor(ui.frame, waitText);
}

afterEach(cleanup);

describe('acting on a Decision Request from the TUI', () => {
  test('decide: pick a Choice and give a rationale', async () => {
    const ui = open();
    await openItem(ui, 0, 'd decide');
    expect(ui.frame()).toContain('i ask for info · s reassign');
    await press(ui.stdin, 'd');
    await waitFor(ui.frame, 'A. Poll every minute');
    await press(ui.stdin, KEY.enter);
    await waitFor(ui.frame, 'Rationale (optional)');
    await press(ui.stdin, 'Cheap, and quick', KEY.enter);
    await waitFor(ui.frame, '✔ Decided.');
    expect(ui.calls.actions).toEqual([
      { name: 'decide', args: [toDecide.id, { choiceId: id(401), rationale: 'Cheap, and quick' }] },
    ]);
  });

  test('decide in my own words; typing q or r in a form never quits or opens raise', async () => {
    const ui = open();
    await openItem(ui, 0, 'd decide');
    await press(ui.stdin, 'd', 'j', 'j');
    await waitFor(ui.frame, '› Answer in my own words');
    await press(ui.stdin, KEY.enter);
    await waitFor(ui.frame, 'Your answer:');
    await press(ui.stdin, KEY.enter);
    await waitFor(ui.frame, 'Write your answer first');
    await press(ui.stdin, 'quit retrying', KEY.enter);
    await waitFor(ui.frame, 'Rationale (optional)');
    await press(ui.stdin, KEY.enter);
    await waitFor(ui.frame, '✔ Decided.');
    expect(ui.calls.actions).toEqual([
      { name: 'decide', args: [toDecide.id, { customAnswer: 'quit retrying' }] },
    ]);
  });

  test('Esc cancels a form without sending; Esc again goes back to the list', async () => {
    const ui = open();
    await openItem(ui, 0, 'd decide');
    await press(ui.stdin, 'i');
    await waitFor(ui.frame, 'Ask the Raiser for more info');
    await press(ui.stdin, KEY.escape);
    await waitFor(ui.frame, 'd decide');
    expect(ui.calls.actions).toEqual([]);
    await press(ui.stdin, KEY.escape);
    await waitFor(ui.frame, 'Inbox Items (5)');
  });

  test('ask for info and add a note', async () => {
    const ui = open();
    await openItem(ui, 0, 'd decide');
    await press(ui.stdin, 'i', 'Which provider?', KEY.enter);
    await waitFor(ui.frame, '✔ Asked for more info.');
    await press(ui.stdin, 'n', 'Checking with legal', KEY.enter);
    await waitFor(ui.frame, '✔ Note added.');
    expect(ui.calls.actions).toEqual([
      { name: 'postMessage', args: [toDecide.id, { kind: 'QUESTION', body: 'Which provider?' }] },
      { name: 'postMessage', args: [toDecide.id, { kind: 'NOTE', body: 'Checking with legal' }] },
    ]);
  });

  test('reassign to another holder of the decider role', async () => {
    const ui = open();
    await openItem(ui, 0, 's reassign');
    await press(ui.stdin, 's');
    await waitFor(ui.frame, 'Reassign to another PO');
    expect(ui.frame()).toContain('Pim');
    expect(ui.frame()).toContain('Nok');
    await press(ui.stdin, 'j', KEY.enter);
    await waitFor(ui.frame, '✔ Reassigned to Nok.');
    expect(ui.calls.actions).toEqual([{ name: 'reassign', args: [toDecide.id, id(5)] }]);
  });

  test('Claim, and the server message is shown verbatim on a 4xx', async () => {
    const ui = open();
    await openItem(ui, 1, 'c Claim');
    await press(ui.stdin, 'c');
    await waitFor(ui.frame, '✔ Claimed: you are now the Decider.');
    expect(ui.calls.actions).toEqual([{ name: 'claim', args: [toClaim.id] }]);

    cleanup();
    const failing = open({
      reject: { claim: { status: 409, message: 'Nok already Claimed this request' } },
    });
    await openItem(failing, 1, 'c Claim');
    await press(failing.stdin, 'c');
    await waitFor(failing.frame, '✖ Nok already Claimed this request');
  });

  test('the Raiser answers, then withdraws after confirming', async () => {
    const ui = open();
    await openItem(ui, 2, 'a answer');
    expect(ui.frame()).not.toContain('d decide');
    await press(ui.stdin, 'a', 'Stripe', KEY.enter);
    await waitFor(ui.frame, '✔ Answer sent.');

    await press(ui.stdin, 'w');
    await waitFor(ui.frame, 'Withdraw this request?');
    await press(ui.stdin, 'n');
    await waitFor(ui.frame, 'w withdraw');
    expect(ui.calls.actions).toHaveLength(1);

    await press(ui.stdin, 'w');
    await waitFor(ui.frame, 'Withdraw this request?');
    await press(ui.stdin, 'y');
    await waitFor(ui.frame, '✔ Withdrawn.');
    expect(ui.calls.actions).toEqual([
      { name: 'postMessage', args: [needsInfo.id, { kind: 'ANSWER', body: 'Stripe' }] },
      { name: 'withdraw', args: [needsInfo.id] },
    ]);
  });
});

describe('Spec and Brief Proposals in the TUI', () => {
  test('a Spec Proposal shows a colored diff and can be approved', async () => {
    const ui = open();
    await openItem(ui, 3, 'a approve · x reject');
    const text = ui.frame();
    expect(text).toContain('Spec Proposal · Async checkout');
    expect(text).toContain('+2 -1');
    expect(text).toContain('- Poll the provider.');
    expect(text).toContain('+ Poll every minute.');
    expect(text).toContain('+ Retry twice.');
    await press(ui.stdin, 'a');
    await waitFor(ui.frame, '✔ Approved');
    expect(ui.calls.actions).toEqual([{ name: 'approveSpecProposal', args: [SPEC_PROPOSAL_ID] }]);
  });

  test('rejecting asks first; a long diff scrolls and folds unchanged runs', async () => {
    const base = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    const proposed = base.replace('line 2\n', 'line two\n').replace('line 59', 'line 59!');
    const ui = open({
      specProposal: specProposal({ baseMarkdown: base, proposedMarkdown: proposed }),
    });
    await openItem(ui, 3, 'a approve · x reject');
    expect(ui.frame()).toContain('⋯ 50 unchanged lines');
    await press(ui.stdin, 'G');
    await waitFor(ui.frame, '+ line 59!');

    await press(ui.stdin, 'x');
    await waitFor(ui.frame, 'Reject this Spec Proposal?');
    await press(ui.stdin, 'y');
    await waitFor(ui.frame, '✔ Rejected');
    expect(ui.calls.actions).toEqual([{ name: 'rejectSpecProposal', args: [SPEC_PROPOSAL_ID] }]);
  });

  test('p opens the Spec Proposal of a decided request', async () => {
    const decided = request({
      id: id(304),
      status: 'DECIDED',
      specProposal: { id: SPEC_PROPOSAL_ID, status: 'PENDING' },
    });
    const ui = open({ myRequests: [decided], requests: { [decided.id]: decided } });
    await settle();
    await press(ui.stdin, '2');
    await waitFor(ui.frame, '[Decided]');
    await press(ui.stdin, KEY.enter);
    await waitFor(ui.frame, 'p Spec Proposal');
    await press(ui.stdin, 'p');
    await waitFor(ui.frame, '+ Retry twice.');
  });

  test('a Brief Proposal can be approved; a server refusal shows verbatim', async () => {
    const ui = open({
      reject: {
        approveBriefProposal: { status: 403, message: 'Only Beam can approve this Brief Proposal' },
      },
    });
    await openItem(ui, 4, 'Brief Proposal · Mobile Banking');
    expect(ui.frame()).toContain('Sharper goal');
    expect(ui.frame()).toContain('+ New goal');
    await press(ui.stdin, 'a');
    await waitFor(ui.frame, '✖ Only Beam can approve this Brief Proposal');
  });
});

describe('Notifications and live updates', () => {
  test('m marks the selected Notification read, M marks all read', async () => {
    const ui = open();
    await waitFor(ui.frame, 'm mark the selected Notification read');
    await press(ui.stdin, 'j', 'j', 'j', 'j', 'j');
    await waitFor(ui.frame, '› • New Spec Version');
    await press(ui.stdin, 'm');
    await waitFor(ui.frame, '✔ Marked read.');
    await press(ui.stdin, 'M');
    await waitFor(ui.frame, '✔ All Notifications marked read.');
    expect(ui.calls.actions).toEqual([
      { name: 'markNotificationRead', args: [notifications.notifications[0]?.id] },
      { name: 'markAllNotificationsRead', args: [] },
    ]);
  });

  function fakeLive() {
    let handlers: Parameters<LiveFeed>[0] | undefined;
    let stopped = false;
    const live: LiveFeed = (h) => {
      handlers = h;
      return () => {
        stopped = true;
      };
    };
    return {
      live,
      emit: (e: ServerEvent) => handlers?.onEvent(e),
      status: (s: LiveStatus) => handlers?.onStatus(s),
      stopped: () => stopped,
    };
  }

  test('events refresh the Inbox and pop OS notifications; the indicator follows the stream', async () => {
    const feed = fakeLive();
    const shown = items.slice(0, 1);
    const ui = open({ inbox: shown }, { live: feed.live });
    await waitFor(ui.frame, 'Inbox Items (1)');
    feed.status({ state: 'connecting' });
    await waitFor(ui.frame, '◌ connecting…');
    feed.status({ state: 'live' });
    await waitFor(ui.frame, '● live');
    expect(ui.notified).toEqual([]);

    // Someone raises a request to me: inbox.changed, then a new Inbox Item appears.
    shown.push(items[1] as InboxItem);
    const before = ui.calls.loads.filter((l) => l === 'inbox').length;
    feed.emit({ event: 'inbox.changed', data: {} });
    feed.emit({ event: 'inbox.changed', data: {} });
    await waitFor(ui.frame, 'Inbox Items (2)');
    // Two events in a burst, one refresh.
    expect(ui.calls.loads.filter((l) => l === 'inbox').length).toBe(before + 1);
    expect(ui.notified).toEqual([
      ['Vorasaan: needs you', 'Claim Blocker: Which provider? · Async checkout (PO)'],
    ]);

    // A Decision made by someone else arrives as a Notification.
    const decided = {
      ...(notifications.notifications[0] as (typeof notifications.notifications)[number]),
      id: id(602),
      type: 'REQUEST_DECIDED' as const,
      decisionRequest: { ...ref(needsInfo), status: 'DECIDED' as const },
      specVersion: null,
    };
    feed.emit({ event: 'notification.created', data: { notification: decided } });
    expect(ui.notified.at(-1)).toEqual([
      'Vorasaan',
      'Decided: Provider has no webhook · Async checkout',
    ]);

    feed.status({ state: 'offline', reason: 'Cannot reach', retryInMs: 2000 });
    await waitFor(ui.frame, '○ offline · retrying in 2s');
    feed.status({ state: 'stopped', reason: 'Live updates stopped: your sign-in was rejected.' });
    await waitFor(ui.frame, '✖ live updates off');
    expect(ui.frame()).toContain('Live updates stopped: your sign-in was rejected.');

    ui.unmount();
    expect(feed.stopped()).toBe(true);
  });

  test('a burst of new Inbox Items becomes one OS notification', async () => {
    const feed = fakeLive();
    const shown: InboxItem[] = [];
    const ui = open({ inbox: shown }, { live: feed.live });
    await waitFor(ui.frame, 'No Inbox Items');
    shown.push(...items);
    feed.emit({ event: 'inbox.changed', data: {} });
    await waitFor(ui.frame, 'Inbox Items (5)');
    expect(ui.notified).toEqual([['Vorasaan: needs you', '5 new Inbox Items']]);
  });

  test("a Conversation's streamed reply doesn't refresh anything", async () => {
    const feed = fakeLive();
    const ui = open({}, { live: feed.live });
    await waitFor(ui.frame, 'Inbox Items (5)');
    const before = ui.calls.loads.length;
    const conversationId = id(700);
    const messageId = id(701);
    feed.emit({ event: 'conversation.delta', data: { conversationId, messageId, delta: 'Hi' } });
    feed.emit({
      event: 'conversation.failed',
      data: { conversationId, messageId, message: 'The AI failed' },
    });
    await settle(400);
    expect(ui.calls.loads.length).toBe(before);
    expect(ui.notified).toEqual([]);
  });

  test('"retrying in Ns" counts down while offline', async () => {
    const feed = fakeLive();
    const ui = open({}, { live: feed.live });
    await waitFor(ui.frame, 'Inbox Items (5)');
    feed.status({ state: 'offline', reason: 'Cannot reach', retryInMs: 2200 });
    await waitFor(ui.frame, '○ offline · retrying in 3s');
    await waitFor(ui.frame, '○ offline · retrying in 2s', 1000);
    await waitFor(ui.frame, '○ offline · retrying in 1s', 1500);
    // It never shows 0s; the next status replaces it.
    await settle(1300);
    expect(ui.frame()).toContain('retrying in 1s');
    feed.status({ state: 'offline', reason: 'Cannot reach', retryInMs: 4000 });
    await waitFor(ui.frame, '○ offline · retrying in 4s');
    feed.status({ state: 'live' });
    await waitFor(ui.frame, '● live');
  }, 10_000);

  test('after a live refresh the cursor stays on the same item, not the same row', async () => {
    const feed = fakeLive();
    const shown = [items[0], items[1]] as InboxItem[];
    const ui = open({ inbox: shown }, { live: feed.live });
    await waitFor(ui.frame, 'Inbox Items (2)');
    await press(ui.stdin, 'j');
    await waitFor(ui.frame, '› Claim Blocker: Which provider?');

    // A new Inbox Item arrives above the selected one.
    shown.unshift(items[2] as InboxItem);
    feed.emit({ event: 'inbox.changed', data: {} });
    await waitFor(ui.frame, 'Inbox Items (3)');
    expect(ui.frame()).toContain('› Claim Blocker: Which provider?');
    await press(ui.stdin, KEY.enter);
    await waitFor(ui.frame, 'c Claim');
    expect(ui.frame()).toContain('Which provider?');
    await press(ui.stdin, KEY.escape);
    await waitFor(ui.frame, '› Claim Blocker: Which provider?');

    // The selected item goes away: the cursor stays on the row it was last on (3rd),
    // which now holds the next entry.
    shown.splice(2, 1);
    feed.emit({ event: 'inbox.changed', data: {} });
    await waitFor(ui.frame, 'Inbox Items (2)');
    expect(ui.frame()).toContain('› • New Spec Version v2 by Pim');
  });

  test('My Requests keeps the cursor on the same request when the list reorders', async () => {
    const feed = fakeLive();
    const first = request({ id: id(311), title: 'First request' });
    const second = request({ id: id(312), title: 'Second request' });
    const mine = [first, second];
    const ui = open({ myRequests: mine }, { live: feed.live });
    await waitFor(ui.frame, 'Inbox Items (5)');
    await press(ui.stdin, '2');
    await waitFor(ui.frame, 'Second request');
    await press(ui.stdin, 'j');
    await waitFor(ui.frame, '› [Open] Blocker: Second request');
    mine.reverse();
    feed.emit({ event: 'inbox.changed', data: {} });
    await settle(400);
    await waitFor(ui.frame, '› [Open] Blocker: Second request');
    expect(ui.frame().indexOf('Second request')).toBeLessThan(ui.frame().indexOf('First request'));
  });

  test('a ✔ message clears once a refresh shows something changed, not on its own echo', async () => {
    const feed = fakeLive();
    const requests = { [toDecide.id]: toDecide };
    const ui = open({ requests }, { live: feed.live });
    await openItem(ui, 0, 'd decide');
    await press(ui.stdin, 'n', 'Noted', KEY.enter);
    await waitFor(ui.frame, '✔ Note added.');

    // The server echoes my own action: nothing else changed, so the message stays.
    feed.emit({ event: 'inbox.changed', data: {} });
    await settle(400);
    expect(ui.frame()).toContain('✔ Note added.');

    // Someone else changes the request: the message is stale now.
    requests[toDecide.id] = { ...toDecide, title: 'Which retry policy, really?' };
    feed.emit({ event: 'inbox.changed', data: {} });
    await waitFor(ui.frame, 'Which retry policy, really?');
    expect(ui.frame()).not.toContain('✔ Note added.');
  });

  test('a ✔ message on the list clears when a live refresh changes the Inbox', async () => {
    const feed = fakeLive();
    const shown = items.slice(0, 1);
    const ui = open({ inbox: shown }, { live: feed.live });
    await waitFor(ui.frame, 'Inbox Items (1)');
    await press(ui.stdin, 'M');
    await waitFor(ui.frame, '✔ All Notifications marked read.');
    feed.emit({ event: 'inbox.changed', data: {} });
    await settle(400);
    expect(ui.frame()).toContain('✔ All Notifications marked read.');

    shown.push(items[1] as InboxItem);
    feed.emit({ event: 'inbox.changed', data: {} });
    await waitFor(ui.frame, 'Inbox Items (2)');
    expect(ui.frame()).not.toContain('✔ All Notifications marked read.');
  });

  test('an open request reloads on a live event without closing its form', async () => {
    const feed = fakeLive();
    const ui = open({}, { live: feed.live });
    await openItem(ui, 0, 'd decide');
    await press(ui.stdin, 'n', 'half');
    const loads = ui.calls.loads.filter((l) => l === 'decisionRequest').length;
    feed.emit({ event: 'inbox.changed', data: {} });
    await settle(400);
    expect(ui.calls.loads.filter((l) => l === 'decisionRequest').length).toBe(loads + 1);
    await press(ui.stdin, ' typed', KEY.enter);
    await waitFor(ui.frame, '✔ Note added.');
    expect(ui.calls.actions).toEqual([
      { name: 'postMessage', args: [toDecide.id, { kind: 'NOTE', body: 'half typed' }] },
    ]);
  });
});
