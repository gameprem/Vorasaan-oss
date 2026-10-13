import { createServer, type Server } from 'node:http';
import { E2E } from './env';
import { chooseOption, expect, expectNoViolations, pim, THEMES, test, unique } from './fixtures';

// Gemini in Settings → AI models (ticket 0080): an Admin connects it with a key only,
// searches the Gemini API's model list (read with that key), and a picked model gets its
// input token limit as its Context Window. When the list can't be loaded, the Admin is
// told to type the model id. Each run removes what it added, so no other spec sees it.

/** The fake Gemini API: only its model list is used here. */
let fakeGemini: Server;
let listStatus = 200;
const KEY = 'AIza-e2e-gemini-key-0080';

const MODELS = [
  {
    name: 'models/gemini-example-pro',
    displayName: 'Gemini Example Pro',
    inputTokenLimit: 2_000_000,
    supportedGenerationMethods: ['generateContent'],
  },
  {
    name: 'models/gemini-example-flash',
    displayName: 'Gemini Example Flash',
    inputTokenLimit: 1_000_000,
    supportedGenerationMethods: ['generateContent'],
  },
  {
    name: 'models/example-embedding',
    displayName: 'Example Embedding',
    inputTokenLimit: 2_048,
    supportedGenerationMethods: ['embedContent'],
  },
];

test.beforeAll(async () => {
  fakeGemini = createServer((req, res) => {
    const ok =
      req.method === 'GET' &&
      req.url?.startsWith('/v1beta/models?') &&
      req.headers['x-goog-api-key'] === KEY &&
      listStatus === 200;
    if (ok) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: MODELS }));
      return;
    }
    res.writeHead(listStatus === 200 ? 404 : listStatus).end('unavailable');
  });
  await new Promise<void>((resolve) => fakeGemini.listen(E2E.fakeGeminiPort, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => fakeGemini.close(resolve));
});

for (const theme of THEMES) {
  test(`an Admin connects Gemini, picks a model from its list by keyboard, and gets its window, in ${theme}`, async ({
    as,
  }) => {
    listStatus = 200;
    const name = unique(`Gemini ${theme}`);
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    page.on('dialog', (d) => d.accept());
    await page.goto('/settings/ai');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    // Settings has hydrated once it has moved the focus to Back.
    await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();

    // Connect: a name and a key, no URL.
    const connect = dialog.getByRole('button', { name: 'Connect a provider' });
    if (await connect.isVisible()) await connect.click();
    const form = dialog.getByRole('form', { name: 'Connect a provider' });
    await form.getByText('Gemini API', { exact: true }).click();
    await expect(form.getByText('Google AI Studio')).toBeVisible();
    await expect(form.getByLabel('Base URL')).toHaveCount(0);
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Gemini API key').fill(KEY);
    await expectNoViolations(page);
    await form.getByRole('button', { name: 'Connect' }).click();
    // The provider's row (a model's row names its provider too).
    const row = dialog
      .getByRole('listitem')
      .filter({ hasText: name })
      .filter({ hasText: 'key ends in' });
    await expect(row).toContainText('Gemini API · key ends in 0080');

    // Add a model: search the list and pick one by keyboard; its window follows.
    await dialog.getByRole('button', { name: 'Add a model' }).click();
    const add = dialog.getByRole('form', { name: 'Add model' });
    await chooseOption(add, 'Provider', `${name} (Gemini API)`);
    const models = add.getByRole('list', { name: 'Gemini models' });
    // Only the models that generate text.
    await expect(models.getByRole('button')).toHaveCount(2);
    const search = add.getByLabel('Search Gemini models');
    await search.fill('flash');
    await expect(models.getByRole('button')).toHaveCount(1);
    await search.press('Tab');
    await expect(models.getByRole('button', { name: /Gemini Example Flash/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(add.getByLabel('Model id')).toHaveValue('gemini-example-flash');
    await expect(add.getByLabel('Context window (tokens)')).toHaveValue('1000000');
    await expectNoViolations(page);
    const displayName = unique(`Gemini Flash ${theme}`).slice(0, 60);
    await add.getByLabel('Display name').fill(displayName);
    await add.getByRole('button', { name: 'Add model' }).click();
    const modelRow = dialog.getByRole('listitem').filter({ hasText: displayName });
    await expect(modelRow).toContainText('gemini-example-flash');
    await expect(modelRow).toContainText('1M tokens');

    // When the list can't be loaded, the model id is typed.
    listStatus = 503;
    await dialog.getByRole('button', { name: 'Add a model' }).click();
    const again = dialog.getByRole('form', { name: 'Add model' });
    await chooseOption(again, 'Provider', `${name} (Gemini API)`);
    await expect(again.getByRole('status')).toContainText(
      'The Gemini API answered 503 for its model list',
    );
    await expect(again.getByRole('status')).toContainText('Type the model id instead');
    await expect(again.getByLabel('Model id')).toBeEditable();
    await again.getByRole('button', { name: 'Cancel' }).click();
    listStatus = 200;

    // Leave nothing behind: the model, then the provider.
    await modelRow.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog.getByRole('listitem').filter({ hasText: displayName })).toHaveCount(0);
    await expect(row).toContainText('0 models');
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
  });
}
