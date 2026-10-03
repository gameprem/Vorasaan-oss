import {
  dateGroup,
  expect,
  expectNoViolations,
  POPOVER,
  pim,
  selectButton,
  THEMES,
  test,
} from './fixtures';

// The UI kit (ADR 0016, ticket 0077): every control works with the keyboard alone, screen
// readers get the options and the picked date, and axe finds no violations, in light and
// dark, on the gallery (/dev/ui) and on the key forms.

for (const theme of THEMES) {
  test(`the gallery has no axe violations in ${theme}, with its pickers open`, async ({ as }) => {
    const page = await as(pim);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/dev/ui');
    await expect(page.getByRole('heading', { name: 'UI kit', level: 1 })).toBeVisible();
    await expectNoViolations(page);

    // A Select's list, a ComboBox's list and a date picker's calendar, each open. React Aria
    // hides the rest of the page from screen readers meanwhile, so axe checks the popover.
    await selectButton(page, 'Approved Model').click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await expectNoViolations(page, POPOVER);
    await page.keyboard.press('Escape');

    await page.getByRole('combobox', { name: 'Project or Feature', exact: true }).click();
    await page.keyboard.type('a');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expectNoViolations(page, POPOVER);
    await page.keyboard.press('Escape');

    await dateGroup(page.getByRole('region', { name: 'Date and time' }), 'Holiday')
      .getByRole('button')
      .click();
    await expect(page.getByRole('grid')).toBeVisible();
    await expectNoViolations(page, POPOVER);
    await page.keyboard.press('Escape');
  });
}

test('every control of the gallery form works with the keyboard alone', async ({ as }) => {
  const page = await as(pim);
  await page.goto('/dev/ui');
  const form = page.getByRole('form', { name: 'Form demo' });
  const { keyboard } = page;

  // Select: focus, open with the arrow, move, pick with Enter.
  await selectButton(form, 'Decider role').focus();
  await keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'PO' })).toBeFocused();
  await keyboard.press('ArrowDown');
  await keyboard.press('Enter');
  await expect(selectButton(form, 'Decider role')).toContainText('Designer');

  // ComboBox: Tab in, type to search, arrow to the match, Enter.
  await keyboard.press('Tab');
  await expect(form.getByRole('combobox', { name: 'Model', exact: true })).toBeFocused();
  await keyboard.press('ControlOrMeta+a');
  await keyboard.type('local');
  await keyboard.press('ArrowDown');
  await keyboard.press('Enter');
  await expect(form.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('Local');

  // Person picker: search by name.
  await form.getByRole('combobox', { name: 'Delegate', exact: true }).focus();
  await keyboard.type('fern');
  await keyboard.press('ArrowDown');
  await keyboard.press('Enter');
  await expect(form.getByRole('combobox', { name: 'Delegate', exact: true })).toHaveValue(
    'Fern Wong',
  );

  // Time zone: Thai finds Bangkok.
  const tz = form.getByRole('combobox', { name: 'Time zone', exact: true });
  await tz.focus();
  await keyboard.press('ControlOrMeta+a');
  await keyboard.type('โตเกียว');
  await keyboard.press('ArrowDown');
  await keyboard.press('Enter');
  await expect(tz).toHaveValue('Asia/Tokyo');

  // Date: type into the segments (dd/mm/yyyy in en-GB).
  await dateGroup(form, 'Holiday').getByRole('spinbutton').first().focus();
  await keyboard.type('01052026');
  // Day and time.
  await dateGroup(form, 'Starts').getByRole('spinbutton').first().focus();
  await keyboard.type('060120270830');
  // Time.
  await dateGroup(form, 'Quiet from').getByRole('spinbutton').first().focus();
  await keyboard.type('2315');

  // Radio: arrows move the choice.
  await form.getByRole('radio', { name: 'Blocker' }).focus();
  await keyboard.press('ArrowDown');
  await expect(form.getByRole('radio', { name: 'Question' })).toBeChecked();

  // Checkbox and Switch: Space toggles.
  await form.getByRole('checkbox', { name: 'Ask as plain text' }).focus();
  await keyboard.press('Space');
  await expect(form.getByRole('checkbox', { name: 'Ask as plain text' })).toBeChecked();
  await form.getByRole('switch', { name: 'Notify the Team' }).focus();
  await keyboard.press('Space');
  await expect(form.getByRole('switch', { name: 'Notify the Team' })).not.toBeChecked();

  // Segmented control: arrows move, Space picks.
  await form.getByRole('radio', { name: 'Hours' }).focus();
  await keyboard.press('ArrowRight');
  await keyboard.press('Space');
  await expect(form.getByRole('radio', { name: 'Days' })).toBeChecked();

  // Submit with Enter on the button: FormData carries every value.
  await form.getByRole('button', { name: 'Submit the demo' }).focus();
  await keyboard.press('Enter');
  const sent = JSON.parse((await form.getByRole('status').textContent()) || '{}');
  expect(sent).toEqual({
    role: 'DESIGNER',
    model: 'local',
    delegate: 'fern',
    timeZone: 'Asia/Tokyo',
    holiday: '2026-05-01',
    startsAt: '2027-01-06T08:30',
    quietFrom: '23:15',
    kind: 'QUESTION',
    plainText: 'on',
    unit: 'WORKING_DAYS',
  });
});

test('screen readers get a ComboBox’s options and the picked date', async ({ as }) => {
  const page = await as(pim);
  await page.goto('/dev/ui');
  const section = page.getByRole('region', { name: 'ComboBox' });
  const tz = section.getByRole('combobox', { name: 'Time zone', exact: true });
  await tz.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('กรุงเทพ');
  await expect(tz).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('listbox');
  await expect(list).toMatchAriaSnapshot(`
    - listbox:
      - option /^Asia\\/Bangkok/
  `);
  await page.keyboard.press('ArrowDown');
  // The focused option is announced through aria-activedescendant.
  const active = await tz.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  await expect(page.locator(`[id="${active}"]`)).toHaveAccessibleName(/^Asia\/Bangkok/);
  await expect(page.locator(`[id="${active}"]`)).toHaveAccessibleDescription(/UTC\+07:00/);
  await page.keyboard.press('Enter');

  // The date: each segment says what it is and its value; the Buddhist-era one shows 2569.
  const dates = page.getByRole('region', { name: 'Date and time' });
  const plain = dateGroup(dates, 'Holiday');
  // Day, month, year in en-GB.
  await expect(plain.getByRole('spinbutton').nth(2)).toHaveText('2026');
  await expect(plain.getByRole('spinbutton').nth(2)).toHaveAttribute('aria-valuetext', /2026/);
  await expect(plain.getByRole('spinbutton').nth(1)).toHaveAttribute('aria-valuetext', /March/);
  const be = dateGroup(dates, 'Holiday (Buddhist era)');
  await expect(be.getByRole('spinbutton').nth(2)).toHaveText('2569');
  await be.getByRole('button').click();
  await expect(page.getByRole('grid')).toHaveAccessibleName(/2569/);
  await expect(page.getByRole('gridcell', { selected: true })).toBeVisible();
});
