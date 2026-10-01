import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { App } from './App.tsx';
import { fakeApi, features, PROJECT_A } from './fixtures.ts';
import { KEY, press, settle, waitFor } from './test-helpers.ts';

const { enter: ENTER, escape: ESC, down: DOWN } = KEY;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vorasaan-tui-raise-'));
  await writeFile(join(dir, 'notes.md'), 'The provider only supports polling.\n');
  await writeFile(join(dir, '.env'), 'API_KEY=sk_live_123\n');
});
afterEach(async () => {
  cleanup();
  await rm(dir, { recursive: true, force: true });
});

function open() {
  const fake = fakeApi();
  const ui = render(
    <App api={fake.api} repo={{ root: dir, cwd: dir, projectId: PROJECT_A }} height={30} />,
  );
  return { ...fake, ...ui, frame: () => ui.lastFrame() ?? '' };
}

describe('raise form (r)', () => {
  test('raises with repository context and sends to the chosen decider role', async () => {
    const { stdin, frame, calls } = open();
    await settle();
    await press(stdin, '3');
    await waitFor(frame, 'Async checkout');
    await press(stdin, 'r');
    await waitFor(frame, 'Which Feature?');
    // Scoped to the bound Project; the Feature under the cursor is preselected.
    expect(frame()).toContain('Which Feature?');
    expect(frame()).toContain('› Async checkout');
    expect(frame()).not.toContain('Loyalty points');
    await press(stdin, ENTER);

    expect(frame()).toContain('What kind of Decision Request?');
    await press(stdin, ENTER);

    // Typing "q" and "r" in a field types them; it does not quit or reopen.
    await press(stdin, ENTER);
    expect(frame()).toContain('A title is required');
    await press(stdin, 'quota ran out', ENTER);
    await press(stdin, 'Polling hits the rate limit', ENTER);

    expect(frame()).toContain('Attach the current git diff as context?');
    await press(stdin, ENTER); // No
    expect(frame()).toContain('Files to attach');
    await press(stdin, 'notes.md, .env, ../outside.txt', ENTER);
    await waitFor(frame, 'Send to the');

    expect(calls.raised).toHaveLength(1);
    const raised = calls.raised[0];
    expect(raised).toMatchObject({
      featureId: features[0]?.id,
      kind: 'BLOCKER',
      title: 'quota ran out',
      withChoices: true,
    });
    expect(raised?.description).toStartWith('Polling hits the rate limit');
    expect(raised?.description).toContain('The provider only supports polling.');
    expect(raised?.description).not.toContain('sk_live_123');
    expect(frame()).toContain('Context left out: .env (secret-looking or ignored)');
    expect(frame()).toContain('../outside.txt (outside the repository)');
    expect(frame()).toContain('A. Poll every minute');
    expect(frame()).toContain('Send to the Tech Lead?');

    await press(stdin, DOWN, ENTER); // Change the decider role
    expect(frame()).toContain('Who should decide?');
    await press(stdin, 'k', 'k', 'k', ENTER); // TECH_LEAD -> PO
    expect(frame()).toContain('Send to the PO?');
    await press(stdin, ENTER);
    await waitFor(frame, '✔');

    expect(calls.submitted).toEqual([
      { id: calls.submitted[0]?.id ?? '', input: { deciderRole: 'PO' } },
    ]);
    expect(frame()).toContain('✔ Sent to Tee (PO).');
    expect(calls.withdrawn).toEqual([]);
    await press(stdin, ENTER);
    expect(frame()).toContain('Bound to the Project');
  });

  test('Esc after drafting withdraws the draft and returns to the tab', async () => {
    const { stdin, frame, calls } = open();
    await settle();
    await press(stdin, 'r');
    await waitFor(frame, 'Which Feature?');
    await press(stdin, ENTER, DOWN, DOWN, ENTER);
    await press(stdin, 'Retry policy', ENTER, 'Which one?', ENTER, ENTER, ENTER);
    await waitFor(frame, 'Send to the');
    expect(calls.raised[0]).toMatchObject({ kind: 'QUESTION', withChoices: false });
    expect(frame()).toContain('Send to the Tech Lead?');
    await press(stdin, ESC);
    await waitFor(frame, 'Inbox Items');
    expect(calls.withdrawn).toHaveLength(1);
    expect(calls.submitted).toHaveLength(0);
    expect(frame()).toContain('Inbox Items');
  });

  test('quitting the TUI mid-form never leaves a draft behind', async () => {
    const { stdin, calls, unmount, frame } = open();
    await settle();
    await press(stdin, 'r');
    await waitFor(frame, 'Which Feature?');
    await press(stdin, ENTER, ENTER, 'T', ENTER, 'D', ENTER, ENTER, ENTER);
    await waitFor(frame, 'Send to the');
    expect(calls.raised).toHaveLength(1);
    unmount();
    await settle();
    expect(calls.withdrawn).toHaveLength(1);
  });
});
