import type { APIRequestContext } from '@playwright/test';
import type { SpecVersionView } from '@vorasaan/shared';
import { E2E } from './env';
import { beam, expect, mint, SEED, test, unique } from './fixtures';

// The chat-first journey from end to end (ticket 0048): a Blocker raised in a Feature
// Conversation reaches the Decider's Inbox, is decided there, and the Spec change it leads
// to shows up in the Raiser's Conversation. The fake AI's chat replies are scripted through
// the dev-only POST /dev/fake-ai/chat-script (0046); its Choices and the Spec change come
// from the fake AI as they do for a Blocker raised from the form.

type Chunk =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: { id: string; name: string; args: unknown } };

const asBeam = { 'x-vorasaan-user': beam.id };
const words = (text: string): Chunk[] =>
  (text.match(/\S+\s*/g) ?? []).map((delta) => ({ type: 'text', delta }));

async function scriptChat(request: APIRequestContext, ...replies: { chunks: Chunk[] }[]) {
  const res = await request.post(`${E2E.apiUrl}/dev/fake-ai/chat-script`, {
    headers: asBeam,
    data: { replies },
  });
  expect(res.status()).toBe(204);
}

async function latestSpecVersion(request: APIRequestContext) {
  const res = await request.get(`${E2E.apiUrl}/features/${SEED.featureId}/spec-versions`, {
    headers: asBeam,
  });
  expect(res.status()).toBe(200);
  const versions = (await res.json()) as SpecVersionView[];
  return Math.max(...versions.map((v) => v.version));
}

test('a Blocker raised in chat → sent → Claimed and decided from the Inbox → its Spec change approved → the Raiser sees the new Spec', async ({
  as,
  request,
}) => {
  const title = unique('Hold the order while the provider is down?');
  const before = await latestSpecVersion(request);

  // Mint (PO) has her Inbox open, its live event stream connected.
  const decider = await as(mint);
  const stream = decider.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/events' && r.status() === 200,
  );
  await decider.goto('/inbox');
  await stream;
  const inboxLink = decider
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('link', { name: /^Inbox/ });
  const count = async () =>
    (await inboxLink.locator('.count').count()) > 0
      ? Number((await inboxLink.locator('.count').textContent()) ?? 0)
      : 0;
  const countBefore = await count();
  const toClaim = decider.getByRole('region', { name: /Sent to you, not Claimed yet/ });
  await expect(toClaim.getByText(title)).toHaveCount(0);

  // Beam (Backend) chats in the Feature's Conversation; the AI drafts a Blocker as a card.
  const raiser = await as(beam);
  await raiser.goto(`/conversations/new?feature=${SEED.featureId}`);
  await scriptChat(
    request,
    {
      chunks: [
        ...words('That blocks you, so I drafted a Blocker. '),
        {
          type: 'tool-call',
          call: {
            id: 'e2e-journey-blocker',
            name: 'draftDecisionRequest',
            args: {
              kind: 'BLOCKER',
              title,
              description: 'The provider goes down for minutes at a time; orders fail meanwhile.',
            },
          },
        },
      ],
    },
    { chunks: words('Review it and press Send when it reads right.') },
  );
  const message = raiser.getByRole('textbox', { name: 'Message' });
  await message.fill(
    'I cannot finish checkout: what happens to an order while the provider is down?',
  );
  await message.press('Enter');
  await expect(raiser).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  const conversationUrl = raiser.url();

  const card = raiser.getByRole('article', { name: title });
  await expect(card).toContainText('Decision Request draft');
  await expect(card).toContainText('Blocker');
  await expect(card).toContainText('Proposed');
  await expect(card.getByRole('list', { name: 'Choices' })).toContainText(
    `Option A for "${title}"`,
  );
  await expect(card).toContainText(
    /goes to (Pim and Mint|Mint and Pim); the first to Claim it decides/,
  );
  await expect(raiser.getByText('Drafted a Decision Request')).toBeVisible();
  await expect(raiser.getByRole('log', { name: 'Messages' })).toContainText(
    'Review it and press Send when it reads right.',
  );
  // The Spec is beside the chat, at the version the Blocker is raised against.
  const panel = raiser.getByRole('complementary', { name: 'Spec' });
  await expect(panel).toContainText(`v${before} · approved by`);

  // Nothing is sent until Beam presses Send.
  await card.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(card).toContainText('Approved · sent');
  await expect(card.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(card.getByRole('link', { name: 'Open the Decision Request' })).toBeVisible();

  // It reaches Mint's open Inbox on its own, and the Sidebar's Inbox count goes up.
  await expect(toClaim.getByText(title)).toBeVisible({ timeout: 15_000 });
  await expect.poll(count).toBeGreaterThan(countBefore);

  // She opens it, Claims it and decides.
  await toClaim.getByRole('link').filter({ hasText: title }).click();
  await expect(decider).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const requestPath = new URL(decider.url()).pathname;
  await decider.getByRole('button', { name: 'Claim it' }).click();
  await expect(decider.getByText(/for Mint to decide\./)).toBeVisible();
  await decider.getByText(`Option A for "${title}"`).click();
  await decider.getByRole('button', { name: /^Decide A: / }).click();
  await expect(decider.getByText('Decided by Mint')).toBeVisible();

  // The AI drafted the Spec change; Mint approves it from her Inbox.
  await decider.goto('/inbox');
  const proposals = decider.getByRole('region', { name: /Spec Proposals to approve/ });
  await proposals
    .getByRole('link')
    .filter({ hasText: `Spec change from “${title}”` })
    .click();
  await expect(decider).toHaveURL(requestPath);
  await expect(decider.getByRole('heading', { name: 'Proposed Spec change' })).toBeVisible();
  await decider.getByRole('button', { name: 'Approve Spec change' }).click();
  await expect(decider).toHaveURL(
    new RegExp(`/features/${SEED.featureId}\\?approved=${before + 1}$`),
  );
  await expect(decider.getByText(`Spec v${before + 1} approved.`, { exact: false })).toBeVisible();

  // Beam comes back to his Conversation: its Spec panel and header show the new version.
  await raiser.goto(conversationUrl);
  await expect(panel).toContainText(`v${before + 1} · approved by Mint`);
  await expect(panel.locator('.doc-md')).toContainText(`${title}: `);
  await expect(raiser.getByRole('button', { name: `Spec v${before + 1}` })).toBeVisible();
  await expect(card).toContainText('Approved · sent');
  await card.getByRole('link', { name: 'Open the Decision Request' }).click();
  await expect(raiser).toHaveURL(requestPath);
  await expect(raiser.getByText('Decided and Spec updated')).toBeVisible();
});
