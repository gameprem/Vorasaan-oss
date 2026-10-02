import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { E2E } from './env';
import { beam, expect, pim, test } from './fixtures';

// Linking a LINE account (ticket 0057): an Admin turns LINE on, Beam gets a code, "LINE"
// (this test, signing like LINE does) sends it back, and Beam's page shows the link.

const ACCESS_TOKEN = `e2e-line-access-token-${Date.now()}`;
const CHANNEL_SECRET = `e2e-line-channel-secret-${Date.now()}`;

/** The fake LINE API: records what the server sends to people. */
let fakeLine: Server;
const sent: { path: string; text: string }[] = [];

test.beforeAll(async () => {
  fakeLine = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: { text: string }[] };
      sent.push({ path: req.url ?? '', text: parsed.messages?.[0]?.text ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => fakeLine.listen(E2E.fakeChatPort, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => fakeLine.close(resolve));
});

/** A LINE webhook with one text message, signed with the channel secret. */
async function lineSends(userId: string, text: string, secret = CHANNEL_SECRET) {
  const body = JSON.stringify({
    destination: 'Ubot',
    events: [
      {
        type: 'message',
        mode: 'active',
        webhookEventId: `e2e-${Date.now()}-${Math.random()}`,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        replyToken: 'reply-token',
        message: { id: '1', type: 'text', text },
      },
    ],
  });
  return fetch(`${E2E.apiUrl}/chat-apps/line/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-line-signature': createHmac('sha256', secret).update(body).digest('base64'),
    },
    body,
  });
}

test('an Admin turns LINE on, and a person links and unlinks their LINE account', async ({
  as,
}) => {
  // Pim (Admin) turns LINE on. The secrets are never shown again.
  const admin = await as(pim);
  await admin.goto('/settings/chat-apps');
  await expect(admin.getByRole('heading', { name: 'Chat apps', level: 2 })).toBeVisible();
  const line = admin.getByRole('form', { name: 'LINE credentials' });
  await line.getByLabel('Channel access token').fill(ACCESS_TOKEN);
  await line.getByLabel('Channel secret').fill(CHANNEL_SECRET);
  await line.getByRole('button', { name: 'Turn on LINE' }).click();
  await expect(line.getByRole('status')).toHaveText('Saved');
  await expect(admin.getByTestId('chat-app-state-LINE')).toHaveText('On · 0 people linked');
  await expect(line.getByLabel('Channel secret')).toHaveValue('');
  await expect(line.getByLabel('Channel secret')).toHaveAttribute(
    'placeholder',
    'Set. Leave empty to keep it.',
  );
  await admin.reload();
  const html = await admin.content();
  expect(html).not.toContain(ACCESS_TOKEN);
  expect(html).not.toContain(CHANNEL_SECRET);

  // A Member can't see the chat app setup.
  const member = await as(beam);
  await member.goto('/settings/chat-apps');
  await expect(member.getByText('Only an Organization Admin can set up chat apps.')).toBeVisible();

  // Beam gets a one-time code in Settings → Notifications.
  await member.goto('/settings/notifications');
  const row = member.getByRole('listitem', { name: 'LINE' });
  await expect(row.getByTestId('chat-account-LINE')).toHaveText('Not linked');
  await row.getByRole('button', { name: 'Link LINE' }).click();
  const codeBox = row.getByLabel('LINE link code');
  await expect(codeBox).toHaveText(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  const code = (await codeBox.textContent()) ?? '';

  // A forged callback (wrong secret) is refused and links nothing.
  expect((await lineSends('U-beam-phone', code, 'forged-secret')).status).toBe(401);

  // LINE delivers the code; the bot confirms and the page shows the link.
  expect((await lineSends('U-beam-phone', code)).status).toBe(200);
  await expect(row.getByTestId('chat-account-LINE')).toHaveText(/^Linked/);
  await expect(codeBox).toHaveCount(0);
  expect(sent.at(-1)).toEqual({
    path: '/v2/bot/message/reply',
    text: expect.stringContaining('Linked to Vorasaan as Beam'),
  });

  // The same code can't link anyone else.
  await lineSends('U-someone-else', code);
  expect(sent.at(-1)?.text).toContain("That code didn't work");

  // Beam unlinks in Vorasaan; LINE is told.
  await row.getByRole('button', { name: 'Unlink LINE' }).click();
  await expect(row.getByTestId('chat-account-LINE')).toHaveText('Not linked');
  await expect.poll(() => sent.at(-1)?.path).toBe('/v2/bot/message/push');
  expect(sent.at(-1)?.text).toContain('Unlinked from Vorasaan by Beam');

  // Quiet hours.
  const prefs = member.getByRole('form', { name: 'Chat app preferences' });
  await expect(prefs.getByLabel(/Decision Requests sent to me/)).toBeChecked();
  await prefs.getByLabel(/Hold chat messages during quiet hours/).check();
  await prefs.getByLabel('From').fill('22:00');
  await prefs.getByLabel('Until').fill('07:00');
  await prefs.getByRole('button', { name: 'Save chat preferences' }).click();
  await expect(prefs.getByRole('status')).toHaveText('Saved');
  await member.reload();
  await expect(
    member.getByRole('form', { name: 'Chat app preferences' }).getByLabel('From'),
  ).toHaveValue('22:00');
});
