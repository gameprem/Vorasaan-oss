import type { APIRequestContext } from '@playwright/test';
import type { ApprovedModelSettingsView } from '@vorasaan/shared';
import { E2E } from './env';
import {
  chooseOption,
  expect,
  expectNoViolations,
  pim,
  SEED,
  selectButton,
  THEMES,
  test,
  unique,
} from './fixtures';

// The Reasoning Level (ticket 0081): an Admin sets it per task in Settings → AI models, and
// "Think deeper" beside the chat input asks for HIGH on one message, shows the reply's
// reasoning tokens, and is off again for the next one. On a model with no reasoning control
// the toggle stays reachable but says why it does nothing. The fake AI reports more thinking
// tokens the higher the level (640 at HIGH). Each run removes what it added.

const asPim = { 'x-vorasaan-user': pim.id };

/** A Claude model (with an effort control) and an OpenAI-compatible one (with none). */
async function twoModels(request: APIRequestContext, tag: string) {
  const added: { providers: string[]; models: ApprovedModelSettingsView[] } = {
    providers: [],
    models: [],
  };
  const providers = [
    { kind: 'ANTHROPIC', name: unique(`Claude ${tag}`), apiKey: 'sk-e2e-not-a-real-key' },
    {
      kind: 'OPENAI_COMPATIBLE',
      name: unique(`Router ${tag}`),
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'e2e-not-a-real-token',
    },
  ];
  const modelIds = ['claude-opus-5-5', 'local-model'];
  for (const [i, data] of providers.entries()) {
    const provider = await request.post(`${E2E.apiUrl}/settings/ai/providers`, {
      headers: asPim,
      data,
    });
    expect(provider.status()).toBe(201);
    const providerId = ((await provider.json()) as { id: string }).id;
    added.providers.push(providerId);
    const model = await request.post(`${E2E.apiUrl}/settings/ai/models`, {
      headers: asPim,
      data: {
        providerId,
        modelId: modelIds[i],
        displayName: unique(i === 0 ? `Deep ${tag}` : `Plain ${tag}`).slice(0, 60),
      },
    });
    expect(model.status()).toBe(201);
    added.models.push((await model.json()) as ApprovedModelSettingsView);
  }
  return added;
}

async function remove(request: APIRequestContext, added: Awaited<ReturnType<typeof twoModels>>) {
  for (const m of added.models) {
    await request.delete(`${E2E.apiUrl}/settings/ai/models/${m.id}`, { headers: asPim });
  }
  for (const id of added.providers) {
    await request.delete(`${E2E.apiUrl}/settings/ai/providers/${id}`, { headers: asPim });
  }
}

for (const theme of THEMES) {
  test(`an Admin sets a task's Reasoning Level in Settings, in ${theme}`, async ({
    as,
    request,
  }) => {
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/settings/ai');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();
    const section = dialog.getByRole('region', { name: 'Reasoning Level per task' });
    await expect(section).toBeVisible();

    // The defaults show on each task: low for Choices, medium for chat.
    await expect(selectButton(section, 'Reasoning Level: Choices')).toContainText('Default (Low)');
    await expect(selectButton(section, 'Reasoning Level: Chat')).toContainText('Default (Medium)');

    await chooseOption(section, 'Reasoning Level: Choices', 'High');
    await section.getByRole('button', { name: 'Save Reasoning Levels' }).click();
    await expect(section.getByRole('status')).toHaveText('Saved.');
    await expectNoViolations(page);

    // It is what the server now has, and the next call runs at it.
    const saved = await request.get(`${E2E.apiUrl}/settings/ai`, { headers: asPim });
    const tasks = ((await saved.json()) as { tasks: { task: string; reasoningLevel: string }[] })
      .tasks;
    expect(tasks.find((t) => t.task === 'CHOICES')?.reasoningLevel).toBe('HIGH');

    // Back to the default, so no other spec sees it.
    await chooseOption(section, 'Reasoning Level: Choices', 'Default (Low)');
    await section.getByRole('button', { name: 'Save Reasoning Levels' }).click();
    await expect(section.getByRole('status')).toHaveText('Saved.');
    const reset = await request.get(`${E2E.apiUrl}/settings/ai`, { headers: asPim });
    expect(
      (
        (await reset.json()) as { tasks: { task: string; reasoningLevel: string | null }[] }
      ).tasks.find((t) => t.task === 'CHOICES')?.reasoningLevel,
    ).toBeNull();
  });

  test(`"Think deeper" asks for HIGH on one message, and says why when the model can't, in ${theme}`, async ({
    as,
    request,
  }) => {
    const added = await twoModels(request, theme);
    const [deep, plain] = added.models as [ApprovedModelSettingsView, ApprovedModelSettingsView];
    try {
      const page = await as(pim);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/conversations/new?feature=${SEED.featureId}`);
      const message = page.getByRole('textbox', { name: 'Message' });
      const log = page.getByRole('log', { name: 'Messages' });
      const toggle = page.getByRole('button', { name: 'Think deeper' });

      // From the message field, Tab alone reaches the toggle.
      const tabTo = async (target: typeof toggle) => {
        await message.focus();
        for (
          let i = 0;
          i < 8 && !(await target.evaluate((el) => el === document.activeElement));
          i++
        ) {
          await page.keyboard.press('Tab');
        }
        await expect(target).toBeFocused();
      };

      // Pick the model with a reasoning control.
      const pickModel = async (name: string) => {
        await page.getByRole('button', { name: /^Model: / }).click();
        const menu = page.getByRole('menu', { name: 'Models your Admin approved' });
        await menu.getByRole('menuitemradio', { name }).click();
        await expect(menu).toHaveCount(0);
      };
      await pickModel(deep.displayName);

      // Off by default; reachable with Tab from the model menu, Space turns it on.
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await tabTo(toggle);
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expectNoViolations(page, 'form.composer');

      await message.fill(unique('Think hard about retries'));
      await message.press('Enter');
      await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
      const thought = log.locator('.thought');
      await expect(thought).toHaveCount(1);
      await expect(thought).toHaveText('Thought deeper · 640 reasoning tokens');
      // It applied to that message alone.
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');

      await message.fill('And timeouts?');
      await message.press('Enter');
      await expect(log.locator('.msg.ai .by')).toHaveCount(2);
      await expect(thought).toHaveCount(1);

      // A model with no reasoning control: still focusable, does nothing, says why.
      await pickModel(plain.displayName);
      await expect(toggle).toHaveAttribute('aria-disabled', 'true');
      await tabTo(toggle);
      await expect(toggle).toHaveAccessibleDescription(
        'Not available: Not supported by this provider.',
      );
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      // The composer and the reply's thinking line. (The page's own disclaimer is outside
      // this ticket.)
      await expectNoViolations(page, 'form.composer');
      await expectNoViolations(page, '.msg.ai .thought');
    } finally {
      await remove(request, added);
    }
  });
}
