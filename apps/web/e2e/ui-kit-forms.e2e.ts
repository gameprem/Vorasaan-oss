import type { Page } from '@playwright/test';
import {
  chooseOption,
  dateGroup,
  expect,
  expectNoViolations,
  POPOVER,
  pim,
  SEED,
  selectButton,
  THEMES,
  test,
} from './fixtures';

// The key forms on the UI kit (ticket 0077): each is filled with the keyboard alone, and
// axe finds no violations in light or dark. Nothing here is saved that another spec reads,
// except a Delegation far in the future.

/** Settings has hydrated: it moves the focus to Back once, which would steal ours. */
const settled = (page: Page) => expect(page.getByRole('button', { name: 'Back' })).toBeFocused();

for (const theme of THEMES) {
  test(`Settings → Delegations works by keyboard, axe-clean in ${theme}`, async ({ as }) => {
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/settings/delegations');
    await settled(page);
    const { keyboard } = page;
    // Other specs add Teams; the seeded one is Pim's as PO.
    if (await selectButton(page, 'Team').count()) {
      await chooseOption(page, 'Team', 'Mobile Banking / Checkout');
    }
    await expect(selectButton(page, 'Team Role')).toContainText('PO');

    // The Delegate: search by name, arrow, Enter.
    await page.getByRole('combobox', { name: 'Delegate', exact: true }).focus();
    await keyboard.type('Mint');
    await keyboard.press('ArrowDown');
    await keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: 'Delegate', exact: true })).toHaveValue('Mint');

    // Starts and Ends, typed into the segments (dd/mm/yyyy, hh:mm), years ahead.
    const starts = theme === 'light' ? '0101' : '0201';
    await dateGroup(page, 'Starts').getByRole('spinbutton').first().focus();
    await keyboard.type(`${starts}20400900`);
    await dateGroup(page, 'Ends').getByRole('spinbutton').first().focus();
    await keyboard.type(`${starts}20401700`);
    await expect(dateGroup(page, 'Ends').getByRole('spinbutton').nth(2)).toHaveText('2040');

    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Name Delegate' }).focus();
    await keyboard.press('Enter');
    await expect(page.getByText('Delegation saved.')).toBeVisible();
  });

  test(`Settings → AI models works by keyboard, axe-clean in ${theme}`, async ({ as }) => {
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/settings/ai');
    await settled(page);
    const connect = page.getByRole('button', { name: 'Connect a provider' });
    if (await connect.isVisible()) await connect.click();
    const form = page.getByRole('form', { name: 'Connect a provider' });

    // The provider's kind: arrows move the pick, and the Name follows it.
    await form.getByRole('radio', { name: 'Claude API' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(form.getByRole('radio', { name: 'OpenAI API' })).toBeChecked();
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('OpenAI');
    await expectNoViolations(page);

    // A task's model, when there are Approved Models: the open list is axe-clean too.
    const task = page.getByRole('region', { name: 'Model per task' }).getByRole('button').first();
    if (await task.isEnabled()) {
      await task.focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('listbox')).toBeVisible();
      await expectNoViolations(page, POPOVER);
      await page.keyboard.press('Escape');
      await expect(task).toBeFocused();
    }
  });

  test(`Settings → Response Windows works by keyboard, axe-clean in ${theme}`, async ({ as }) => {
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/settings/response-windows');
    await settled(page);
    const form = page.getByRole('form', { name: 'Working calendar and default windows' });
    const { keyboard } = page;

    // The time zone, found in Thai.
    const tz = form.getByRole('combobox', { name: 'Time zone' });
    await tz.focus();
    await keyboard.press('ControlOrMeta+a');
    await keyboard.type('กรุงเทพ');
    await keyboard.press('ArrowDown');
    await keyboard.press('Enter');
    await expect(tz).toHaveValue('Asia/Bangkok');

    // A working day toggles with Space, and back.
    const sat = form.getByRole('checkbox', { name: 'Sat' });
    const was = await sat.isChecked();
    await sat.focus();
    await keyboard.press('Space');
    await expect(sat).toBeChecked({ checked: !was });
    await keyboard.press('Space');
    await expect(sat).toBeChecked({ checked: was });

    // Working hours: arrows step a segment.
    const start = dateGroup(form, 'Working hours start').getByRole('spinbutton').first();
    const hour = await start.textContent();
    await start.focus();
    await keyboard.press('ArrowUp');
    await expect(start).not.toHaveText(hour ?? '');
    await keyboard.press('ArrowDown');
    await expect(start).toHaveText(hour ?? '');

    // A holiday's date, from the calendar by keyboard.
    await form.getByRole('button', { name: 'Add holiday' }).click();
    const holidays = await form.getByRole('group', { name: /^Holiday \d+ date$/ }).count();
    const holiday = form.getByRole('group', { name: `Holiday ${holidays} date` });
    await holiday.getByRole('button').focus();
    await keyboard.press('Enter');
    await expect(page.getByRole('grid')).toBeVisible();
    await expectNoViolations(page, POPOVER);
    await keyboard.press('Enter');
    await expect(holiday.getByRole('spinbutton').nth(2)).not.toHaveText('yyyy');

    await expectNoViolations(page);
  });

  test(`raising a Decision Request works by keyboard, axe-clean in ${theme}`, async ({ as }) => {
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/features/${SEED.featureId}/raise`);
    const { keyboard } = page;
    await page.getByRole('radio', { name: /^Blocker/ }).focus();
    await keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: /^Question/ })).toBeChecked();
    const plain = page.getByRole('checkbox', { name: /Ask as plain text/ });
    await plain.focus();
    await keyboard.press('Space');
    await expect(plain).toBeChecked();
    await expect(page.getByText('You pick who decides before anything is sent.')).toBeVisible();
    await expectNoViolations(page);
  });

  test(`inviting a member works by keyboard, axe-clean in ${theme}`, async ({ as }) => {
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/settings/members');
    await settled(page);
    const access = selectButton(page, 'Access');
    await access.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(access).toContainText('Admin');
    await expectNoViolations(page);
  });
}
