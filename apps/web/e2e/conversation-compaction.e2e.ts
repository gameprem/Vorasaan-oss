import type { APIRequestContext } from '@playwright/test';
import type { ApprovedModelSettingsView, ConversationView } from '@vorasaan/shared';
import { E2E } from './env';
import { expect, pim, SEED, test, unique } from './fixtures';

// Auto-compaction (ticket 0060) in the chat view: once a Conversation's history passes its
// share of the model's window, its older messages are folded into the Conversation Summary.
// They stay stored, behind a quiet "Earlier messages were summarized" marker that opens them.
// The Conversation runs on a small Approved Model (an 8,000-token window), against the
// server's fake AI, so a few long Thai messages are enough.

const asPim = { 'x-vorasaan-user': pim.id };

/** About `chars` Thai characters, one sentence per line. */
function thai(chars: number, tag: string): string {
  const sentence = 'ลูกค้ากดชำระเงินแล้วระบบต้องแสดงสถานะกำลังดำเนินการทันทีโดยไม่ต้องรอผู้ให้บริการ';
  const lines = [tag];
  while (lines.join('\n').length < chars) lines.push(sentence);
  return lines.join('\n');
}

/** A small Approved Model on a stand-in provider (never called: the server runs the fake AI). */
async function smallModel(request: APIRequestContext): Promise<ApprovedModelSettingsView> {
  const listed = await request.get(`${E2E.apiUrl}/settings/ai`, { headers: asPim });
  expect(listed.status()).toBe(200);
  const { models } = (await listed.json()) as { models: ApprovedModelSettingsView[] };
  const existing = models.find((m) => m.displayName === 'Small window');
  if (existing) return existing;
  const provider = await request.post(`${E2E.apiUrl}/settings/ai/providers`, {
    headers: asPim,
    data: {
      kind: 'OPENAI_COMPATIBLE',
      name: 'Local (e2e)',
      baseUrl: 'http://localhost:20128/v1',
      apiKey: 'e2e-local-key',
    },
  });
  expect(provider.status()).toBe(201);
  const { id: providerId } = (await provider.json()) as { id: string };
  const model = await request.post(`${E2E.apiUrl}/settings/ai/models`, {
    headers: asPim,
    data: { providerId, modelId: 'local-small', displayName: 'Small window', contextWindow: 8_000 },
  });
  expect(model.status()).toBe(201);
  return (await model.json()) as ApprovedModelSettingsView;
}

test('older messages fold behind "Earlier messages were summarized", which opens the originals', async ({
  as,
  request,
}) => {
  const model = await smallModel(request);
  const first = thai(1_500, unique('First message'));
  const started = await request.post(`${E2E.apiUrl}/conversations`, {
    headers: asPim,
    data: {
      scope: { kind: 'FEATURE', featureId: SEED.featureId },
      content: first,
      approvedModelId: model.id,
    },
  });
  expect(started.status()).toBe(201);
  const { id } = (await started.json()) as ConversationView;
  for (const n of [2, 3]) {
    const sent = await request.post(`${E2E.apiUrl}/conversations/${id}/messages`, {
      headers: asPim,
      data: { content: thai(1_500, `Message ${n}`) },
    });
    expect(sent.status()).toBe(201);
  }
  const stored = await request.get(`${E2E.apiUrl}/conversations/${id}`, { headers: asPim });
  const conversation = (await stored.json()) as ConversationView;
  expect(conversation.summarizedThrough).toBeGreaterThan(0);
  expect(conversation.messages).toHaveLength(6);

  const page = await as(pim);
  await page.goto(`/conversations/${id}`);
  const log = page.getByRole('log', { name: 'Messages' });
  const marker = log.getByRole('button', { name: 'Earlier messages were summarized' });
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute('aria-expanded', 'false');
  // The summarized messages are folded away; the newest turn is shown as usual.
  const firstLine = first.split('\n')[0] ?? '';
  // The person's first message (the AI's replies quote it too).
  const original = log.locator('.msg.user').filter({ hasText: firstLine });
  await expect(original).toHaveCount(0);
  await expect(log.getByText('Message 3', { exact: false }).first()).toBeVisible();

  // Opening it shows the original messages, word for word, above where the summary ends.
  await marker.click();
  await expect(marker).toHaveAttribute('aria-expanded', 'true');
  await expect(original).toBeVisible();
  await expect(original).toContainText(first.split('\n')[1] ?? '');
  await expect(log.getByText('The AI reads the messages above as a summary')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('summarized-open.png') });

  // And it closes again.
  await marker.click();
  await expect(original).toHaveCount(0);
});
