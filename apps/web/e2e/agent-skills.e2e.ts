import { crc32 } from 'node:zlib';
import type { Page } from '@playwright/test';
import { E2E } from './env';
import { beam, expect, expectNoViolations, pim, SEED, THEMES, test } from './fixtures';

// Agent Skills (ticket 0078, ADR 0017): an Admin installs a Skill from a zip in Settings →
// Agent Skills, sees the scripts left out, reviews and approves it and enables it in the
// Project, all by keyboard; in a Feature Conversation the AI (the fake) loads it, reads its
// SVG template and replies with a diagram, which the page shows in a sandboxed iframe where
// the <script> inside the SVG does not run; the diagram can be downloaded. Then the Admin
// uninstalls it. A Member gets neither the page nor the API. Axe-clean in light and dark.

const SKILL_MD = `---
name: flow-diagram
description: Draws a product flow as one clean SVG diagram of boxes and arrows.
license: MIT
---

# Flow diagram

Start from \`assets/template.svg\` and draw one box per step.
`;

/** The template: its script and onload handler must never run in the page or the iframe. */
const TEMPLATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 80" role="img" aria-label="Checkout flow" onload="document.getElementById('status').textContent='Script ran'">
  <rect x="10" y="20" width="120" height="40" rx="6" fill="#f8fafc" stroke="#334155"/>
  <text x="70" y="45" text-anchor="middle" fill="#0f172a">Tap Pay</text>
  <text id="status" x="210" y="76" text-anchor="middle" fill="#0f172a">Script did not run</text>
  <script>document.getElementById('status').textContent = 'Script ran'; parent.postMessage('ran', '*');</script>
</svg>`;

/** A stored (uncompressed) zip of `files`, built by hand. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const SKILL_ZIP = zip({
  'flow-diagram/SKILL.md': SKILL_MD,
  'flow-diagram/assets/template.svg': TEMPLATE_SVG,
  'flow-diagram/scripts/render.py': 'import os\nos.system("echo never")\n',
});

/** Settings → Agent Skills, once hydrated: the modal has put the focus on Back. */
async function openSettings(page: Page) {
  await page.goto('/settings/agent-skills');
  await expect(page.getByRole('heading', { name: 'Agent Skills', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
}

/** Settings → Agent Skills, as the Admin: install the zip, review, approve and enable it. */
async function installAndApprove(page: Page) {
  await openSettings(page);
  const zipForm = page.getByRole('form', { name: 'Install from a zip' });
  await zipForm.getByLabel('Zip file').setInputFiles({
    name: 'flow-diagram.zip',
    mimeType: 'application/zip',
    buffer: SKILL_ZIP,
  });
  await zipForm.getByRole('button', { name: 'Install from zip' }).press('Enter');
  const status = page.getByRole('status').filter({ hasText: 'Installed flow-diagram' });
  await expect(status).toBeVisible();

  const card = page.getByRole('article', { name: 'flow-diagram' });
  await expect(card).toContainText('Not approved: the AI can’t use it yet');
  await expect(card).toContainText('Version 1 waits for your approval');
  // The script is listed as left out, never stored or run.
  await expect(card.getByRole('listitem').filter({ hasText: 'scripts/render.py' })).toContainText(
    '(script)',
  );
  // Review what the AI would get: every file, as added.
  await card.getByText('Review its files (2 files)').press('Enter');
  await expect(card.getByRole('figure').filter({ hasText: 'SKILL.md (added)' })).toBeVisible();

  // Approve it, then enable it in the seeded Project, by keyboard.
  await card.getByRole('button', { name: 'Approve version 1' }).press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Approved version 1 of flow-diagram.' }),
  ).toBeVisible();
  await expect(card).toContainText('Version 1, in use');
  const project = card.getByRole('checkbox', { name: 'Mobile Banking' });
  await project.focus();
  await page.keyboard.press('Space');
  await expect(project).toBeChecked();
  await card.getByRole('button', { name: 'Save Projects' }).press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'flow-diagram is enabled in 1 Project.' }),
  ).toBeVisible();
  return card;
}

async function uninstall(page: Page) {
  await openSettings(page);
  const card = page.getByRole('article', { name: 'flow-diagram' });
  await card.getByRole('button', { name: 'Uninstall' }).press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Uninstall flow-diagram?' });
  await dialog.getByRole('button', { name: 'Uninstall' }).press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Uninstalled flow-diagram.' }),
  ).toBeVisible();
  await expect(page.getByRole('article', { name: 'flow-diagram' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Installed Agent Skills' })).toBeFocused();
}

for (const theme of THEMES) {
  test(`an approved Skill's SVG shows in a sandboxed iframe where its script never runs (${theme})`, async ({
    as,
  }) => {
    const admin = await as(pim);
    await admin.emulateMedia({ colorScheme: theme });
    await installAndApprove(admin);
    await expectNoViolations(admin);

    try {
      // A script that reached the page itself would post this.
      await admin.goto(`/conversations/new?feature=${SEED.featureId}`);
      await admin.evaluate(() => {
        (window as unknown as { ran?: boolean }).ran = false;
        window.addEventListener('message', (e) => {
          if (e.data === 'ran') (window as unknown as { ran?: boolean }).ran = true;
        });
      });
      const message = admin.getByRole('textbox', { name: 'Message' });
      await message.fill('Draw the checkout flow with flow-diagram');
      await message.press('Enter');

      const frame = admin.locator('iframe[title^="Diagram made by the AI"]');
      await expect(frame).toBeVisible({ timeout: 20_000 });
      await expect(frame).toHaveAttribute('sandbox', '');
      const inside = admin.frameLocator('iframe[title^="Diagram made by the AI"]');
      await expect(inside.getByText('Tap Pay')).toBeVisible();
      await expect(inside.getByText('Script did not run')).toBeVisible();
      await expect(inside.getByText('Script did not run', { exact: true })).toBeVisible();
      await expect(inside.getByText('Script ran', { exact: true })).toHaveCount(0);
      expect(await admin.evaluate(() => (window as unknown as { ran?: boolean }).ran)).toBe(false);
      // Its document forbids scripts and every load, besides the sandbox.
      expect(await frame.getAttribute('srcdoc')).toContain("default-src 'none'");
      await expect(
        admin.getByText('I used the Agent Skill "flow-diagram" for this diagram.'),
      ).toBeVisible();

      // It downloads as an SVG.
      const downloading = admin.waitForEvent('download');
      await admin.getByRole('link', { name: 'Download SVG' }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe('diagram.svg');
      // The Conversation page around the sandboxed output (the iframe's title is checked above).
      await expectNoViolations(admin, 'main');
    } finally {
      await uninstall(admin);
    }
    await expectNoViolations(admin);
  });
}

test('a Member gets neither Settings → Agent Skills nor its API', async ({ as, request }) => {
  const member = await as(beam);
  await member.goto('/settings/agent-skills');
  await expect(
    member.getByText('Only an Organization Admin can install and approve Agent Skills.'),
  ).toBeVisible();
  const api = await request.get(`${E2E.apiUrl}/settings/agent-skills`, {
    headers: { 'x-vorasaan-user': beam.id },
  });
  expect(api.status()).toBe(403);
  const install = await request.post(`${E2E.apiUrl}/settings/agent-skills`, {
    headers: { 'x-vorasaan-user': beam.id },
    data: { url: 'https://github.com/acme/skills' },
  });
  expect(install.status()).toBe(403);
});
