import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import { App, type TuiRepo } from './App.tsx';
import { fakeApi, PROJECT_A, request } from './fixtures.ts';
import { KEY, press, settle, waitFor } from './test-helpers.ts';

const repo: TuiRepo = { root: '/repo', cwd: '/repo' };

function open(options: Parameters<typeof fakeApi>[0] = {}, at: TuiRepo = repo) {
  const fake = fakeApi(options);
  const ui = render(<App api={fake.api} repo={at} height={10} />);
  return { ...fake, ...ui, frame: () => ui.lastFrame() ?? '' };
}

afterEach(cleanup);

describe('vorasaan TUI', () => {
  test('opens on the Inbox: Inbox Items first, then Notifications, with the help line', async () => {
    const { frame } = open();
    await waitFor(frame, 'Notifications (1 unread)');
    const text = frame();
    expect(text).toContain('Inbox Items (2)');
    expect(text).toContain('Decide Question: Which retry policy? · Async checkout');
    expect(text).toContain('Answer Grilling (technical, 3 open) · Mobile Banking');
    expect(text).toContain('Notifications (1 unread)');
    expect(text.indexOf('Inbox Items')).toBeLessThan(text.indexOf('Notifications'));
    expect(text).toContain('q quit');
  });

  test('Tab, Shift-Tab and 1/2/3 switch tabs and refresh each one', async () => {
    const { stdin, frame, calls } = open();
    await settle();
    await press(stdin, KEY.tab);
    await waitFor(frame, '[Open] Blocker: Provider has no webhook · Async checkout');
    await press(stdin, KEY.tab);
    await waitFor(frame, 'Loyalty points');
    await press(stdin, KEY.shiftTab);
    await waitFor(frame, 'Provider has no webhook');
    await press(stdin, '1');
    await waitFor(frame, 'Inbox Items (2)');
    await press(stdin, '3', '2');
    await waitFor(frame, 'Provider has no webhook');
    expect(calls.loads.filter((l) => l === 'myRequests')).toHaveLength(3);
    await press(stdin, 'R');
    expect(calls.loads.filter((l) => l === 'myRequests')).toHaveLength(4);
  });

  test('arrows and j/k move the cursor; Enter opens an Inbox Item, Esc goes back', async () => {
    const { stdin, frame } = open();
    await settle();
    await waitFor(frame, '› Decide Question');
    await press(stdin, 'j');
    await waitFor(frame, '› Answer Grilling');
    await press(stdin, KEY.down, KEY.down);
    await waitFor(frame, '› • New Spec Version v2 by Pim');
    await press(stdin, 'k', KEY.up);
    await waitFor(frame, '› Decide Question');

    await press(stdin, KEY.enter);
    await waitFor(frame, 'Which retry policy?');
    await waitFor(frame, 'A. Poll every minute');
    expect(frame()).not.toContain('Decide, Claim or answer it in the web app.');
    await press(stdin, ' ');
    await waitFor(frame, 'Decide, Claim or answer it in the web app.');

    await press(stdin, KEY.escape);
    await waitFor(frame, 'Inbox Items (2)');
    await press(stdin, 'j', KEY.enter);
    await waitFor(frame, 'Answer them in the web app.');
  });

  test('Features: only the bound Project, highlighted; a shows all; Enter reads the latest Spec', async () => {
    const { stdin, frame } = open({}, { ...repo, projectId: PROJECT_A });
    await settle();
    await press(stdin, '3');
    await waitFor(frame, 'Bound to the Project "Mobile Banking"');
    await waitFor(frame, '● Async checkout');
    expect(frame()).not.toContain('Loyalty points');
    await press(stdin, 'a');
    await waitFor(frame, 'Loyalty points');
    await press(stdin, 'a');
    expect(frame()).not.toContain('Loyalty points');

    await press(stdin, KEY.enter);
    await waitFor(frame, 'Async checkout · Spec v2');
    await waitFor(frame, 'Spec line 1');
    expect(frame()).not.toContain('Spec line 11');
    await press(stdin, 'j', 'j');
    await waitFor(frame, 'lines 3-12 of 40');
    expect(frame()).not.toContain('Spec line 1\n');
    await press(stdin, 'G');
    await waitFor(frame, 'Spec line 40');
    await waitFor(frame, 'lines 31-40 of 40');
    await press(stdin, 'g');
    await waitFor(frame, 'lines 1-10 of 40');
  });

  test('an unbound repo lists every Feature and says how to bind it', async () => {
    const { stdin, frame } = open();
    await settle();
    await press(stdin, '3');
    await waitFor(frame, 'vorasaan init');
    await waitFor(frame, 'Async checkout');
    await waitFor(frame, 'Loyalty points');
  });

  test('a failed request shows a message instead of crashing; empty lists say so', async () => {
    const { stdin, frame } = open({ fail: ['inbox'], myRequests: [] });
    await settle();
    await waitFor(frame, '✖ Cannot reach the Vorasaan server at http://api.test (R to retry)');
    await press(stdin, '2');
    await waitFor(frame, 'You have not raised any Decision Request yet');
    await press(stdin, '1');
    await waitFor(frame, 'Cannot reach');
  });

  test('? toggles the full help', async () => {
    const { stdin, frame } = open();
    await settle();
    await press(stdin, '?');
    await waitFor(frame, 'raise a Blocker or Question with context from this repository');
    await press(stdin, '?');
    expect(frame()).not.toContain('with context from this repository');
  });

  test('My Requests opens the request with its status and Choices', async () => {
    const decided = request({
      status: 'DECIDED',
      decision: {
        id: '00000000-0000-4000-8000-000000000901',
        decidedBy: { id: '00000000-0000-4000-8000-000000000002', name: 'Pim' },
        onBehalfOf: null,
        choiceId: '00000000-0000-4000-8000-000000000401',
        customAnswer: null,
        rationale: 'Good enough for now',
        createdAt: '2026-09-30T10:00:00.000Z',
      },
    });
    const { stdin, frame } = open({ myRequests: [decided] });
    await settle();
    await press(stdin, '2');
    await waitFor(frame, '[Decided] Blocker: Provider has no webhook');
    await press(stdin, KEY.enter);
    await waitFor(frame, 'Raiser: Beam · PO decides · Decider: Pim');
  });
});
