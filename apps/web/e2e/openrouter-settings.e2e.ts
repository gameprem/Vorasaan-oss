import { createServer, type Server } from 'node:http';
import { E2E } from './env';
import { expect, pim, test, unique } from './fixtures';

// OpenRouter in Settings → AI models (ticket 0064): an Admin connects it with a key only,
// searches its model list, and a picked model gets its Context Window from the list. When
// the list can't be loaded, the Admin is told to type the model id.

/** The fake OpenRouter API: only its public model list is used here. */
let fakeOpenRouter: Server;
let listStatus = 200;

const MODELS = [
  { id: 'example/fast-model', name: 'Example: Fast', context_length: 131_072 },
  { id: 'anthropic/example-model', name: 'Anthropic: Example', context_length: 200_000 },
];

test.beforeAll(async () => {
  fakeOpenRouter = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/models' && listStatus === 200) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: MODELS }));
      return;
    }
    res.writeHead(listStatus === 200 ? 404 : listStatus).end('unavailable');
  });
  await new Promise<void>((resolve) =>
    fakeOpenRouter.listen(E2E.fakeOpenRouterPort, '127.0.0.1', resolve),
  );
});

test.afterAll(async () => {
  await new Promise((resolve) => fakeOpenRouter.close(resolve));
});

test('an Admin connects OpenRouter with a key, picks a model from its list, and gets its window', async ({
  as,
}) => {
  listStatus = 200;
  const name = unique('OpenRouter');
  const page = await as(pim);
  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  // Connect: a name and a key, no URL.
  const connect = dialog.getByRole('button', { name: 'Connect a provider' });
  if (await connect.isVisible()) await connect.click();
  const form = dialog.getByRole('form', { name: 'Connect a provider' });
  await form.getByText('OpenRouter', { exact: true }).click();
  await expect(form.getByLabel('Base URL')).toHaveCount(0);
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('OpenRouter API key').fill('sk-or-e2e-key-0064');
  await form.getByRole('button', { name: 'Connect' }).click();
  const row = dialog.getByRole('listitem').filter({ hasText: name });
  await expect(row).toContainText('OpenRouter · key ends in 0064');

  // Add a model: search the list, pick one, and its window follows.
  await dialog.getByRole('button', { name: 'Add a model' }).click();
  const add = dialog.getByRole('form', { name: 'Add model' });
  await add.getByLabel('Provider').selectOption({ label: `${name} (OpenRouter)` });
  const models = add.getByRole('list', { name: 'OpenRouter models' });
  await expect(models.getByRole('button')).toHaveCount(2);
  await add.getByLabel('Search OpenRouter models').fill('anthropic example');
  await expect(models.getByRole('button')).toHaveCount(1);
  await models.getByRole('button', { name: /Anthropic: Example/ }).click();
  await expect(add.getByLabel('Model id')).toHaveValue('anthropic/example-model');
  await expect(add.getByLabel('Context window (tokens)')).toHaveValue('200000');
  const displayName = unique('Via OpenRouter').slice(0, 60);
  await add.getByLabel('Display name').fill(displayName);
  await add.getByRole('button', { name: 'Add model' }).click();
  const modelRow = dialog.getByRole('listitem').filter({ hasText: displayName });
  await expect(modelRow).toContainText('anthropic/example-model');
  await expect(modelRow).toContainText('200k tokens');

  // When the list can't be loaded, the model id is typed.
  listStatus = 503;
  await dialog.getByRole('button', { name: 'Add a model' }).click();
  const again = dialog.getByRole('form', { name: 'Add model' });
  await again.getByLabel('Provider').selectOption({ label: `${name} (OpenRouter)` });
  await expect(again.getByRole('status')).toContainText('Type the model id instead');
  await expect(again.getByLabel('Model id')).toBeEditable();
  await again.getByRole('button', { name: 'Cancel' }).click();
});
