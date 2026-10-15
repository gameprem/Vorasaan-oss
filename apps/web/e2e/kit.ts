import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

// The UI kit's controls (components/ui, ticket 0077), driven the way a person would.

type Scope = Page | Locator;
const pageOf = (scope: Scope): Page => ('page' in scope ? scope.page() : scope);

/** The trigger of the kit Select labelled `label`: its name is the value, then the label. */
export const selectButton = (scope: Scope, label: string) =>
  scope.getByRole('button', { name: new RegExp(`(^|\\s)${escapeRegExp(label)}$`) });

/** The option whose label is `label` (its description follows in the name). */
export const option = (scope: Scope, label: string) =>
  pageOf(scope).getByRole('option', { name: new RegExp(`^${escapeRegExp(label)}( |$)`) });

/** Opens the kit Select labelled `label` and picks the option labelled `choice`. */
export async function chooseOption(scope: Scope, label: string, choice: string) {
  await untilListed(() => selectButton(scope, label).click(), option(scope, choice));
  await option(scope, choice).click();
}

/** Types `search` into the kit ComboBox labelled `label` and picks the option `choice`. */
export async function searchAndChoose(scope: Scope, label: string, search: string, choice: string) {
  const input = scope.getByRole('combobox', { name: label, exact: true });
  await untilListed(
    async () => {
      await input.fill('');
      await input.pressSequentially(search);
    },
    option(scope, choice),
  );
  await option(scope, choice).click();
}

/**
 * Opens a list with `open` until `item` shows: a press before the page has hydrated does
 * nothing, as it would for a person clicking too early.
 */
async function untilListed(open: () => Promise<unknown>, item: Locator) {
  await expect(async () => {
    if (!(await item.isVisible())) await open();
    await expect(item).toBeVisible({ timeout: 1500 });
  }).toPass();
}

/** The kit TimeField or DatePicker labelled `label`: a group of spin buttons. */
export const dateGroup = (scope: Scope, label: string) =>
  scope.getByRole('group', { name: label, exact: true });

/** Types `HH:mm` into the kit TimeField labelled `label`, segment by segment. */
export async function fillTime(scope: Scope, label: string, time: string) {
  const [hour = '', minute = ''] = time.split(':');
  const segments = dateGroup(scope, label).getByRole('spinbutton');
  await segments.nth(0).click();
  await pageOf(scope).keyboard.type(hour + minute);
}

/** What a kit TimeField shows, as "HH:mm". */
export async function timeValue(scope: Scope, label: string) {
  const parts = await dateGroup(scope, label).getByRole('spinbutton').allTextContents();
  return parts.join(':');
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const THEMES = ['light', 'dark'] as const;

/** An open kit popover: a Select's or ComboBox's list, a calendar, a menu. */
export const POPOVER = '[data-trigger]';

/** axe's WCAG 2.1 A and AA rules over `include` (the whole page, Sidebar included, by default). */
export async function expectNoViolations(page: Page, include?: string) {
  // A sandboxed iframe runs no script, axe's included: axe would wait 30 s for each one
  // to answer, so they are left out (the iframe's own title is checked by its spec).
  let axe = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('iframe[sandbox]');
  if (include) axe = axe.include(include);
  const { violations } = await axe.analyze();
  expect(
    violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    ),
  ).toEqual([]);
}

/**
 * Ticks a kit Checkbox or Radio found by its label. Its native input is visually hidden
 * inside the label, so a person (and this) clicks the label.
 */
export async function tick(control: Locator) {
  if (await control.isChecked()) return;
  await control.locator('xpath=ancestor::label[1]').click();
  await expect(control).toBeChecked();
}
