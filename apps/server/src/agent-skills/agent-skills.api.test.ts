import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import {
  type ActionCardView,
  type AgentSkillDiff,
  type AgentSkillsView,
  type AgentSkillUpdateResult,
  type AgentSkillView,
  type AiUsageView,
  type ConversationView,
  ReceiptExportLine,
  type SpecVersionView,
} from '@vorasaan/shared';
import type { ChatChunk, ChatMessageForAi } from '../ai/ai.port.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { chatPrompt } from '../ai/prompts.ts';
import { DEV_USER_HEADER } from '../auth/identity.guard.ts';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { buildZip, type ZipFile } from '../test/zip.ts';
import {
  FLOW_DIAGRAM_SKILL_MD,
  FLOW_DIAGRAM_TEMPLATE_SVG,
  flowDiagramFiles,
  INJECTED_SKILL_MD,
} from './fixtures/flow-diagram.ts';

const { pim, beam } = SEED.users;
const FEATURE = SEED.featureId;
const PROJECT = SEED.projectId;
const BASE = '/settings/agent-skills';
const FLOW_URL = 'https://github.com/acme/skills/tree/main/design/flow-diagram';

type ChatInput = Parameters<FakeAiPort['chat']>[0];

/** A one-zip multipart body, with an optional `subpath` field first. */
function multipart(zip: Uint8Array, subpath?: string) {
  const boundary = `----vorasaan${crypto.randomUUID()}`;
  const field = subpath
    ? `--${boundary}\r\nContent-Disposition: form-data; name="subpath"\r\n\r\n${subpath}\r\n`
    : '';
  const head = `${field}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const inFolder = (folder: string, files: ZipFile[]) =>
  files.map((f) => ({ ...f, path: `${folder}/${f.path}` }));

describe('Agent Skills (ticket 0078)', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let storageDir: string;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  const storage = () => app.get<FileStorage>(FILE_STORAGE);

  async function storedKeys(prefix = 'agent-skills/'): Promise<string[]> {
    const keys: string[] = [];
    for await (const f of storage().list(prefix)) keys.push(f.key);
    return keys.sort();
  }

  function publishFlow(overrides: Partial<Record<string, string>> = {}) {
    return testApp.github.publish('acme', 'skills', [
      ...inFolder('design/flow-diagram', flowDiagramFiles(overrides)),
      {
        path: 'design/other/SKILL.md',
        data: '---\nname: other\ndescription: Another Skill.\n---\n',
      },
      { path: 'README.md', data: '# Skills' },
    ]);
  }

  async function uploadZip(userId: string, url: string, zip: Uint8Array, subpath?: string) {
    const body = multipart(zip, subpath);
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...body.headers, [DEV_USER_HEADER]: userId },
      payload: body.payload,
    });
    return { status: res.statusCode, body: res.json() as AgentSkillView & AgentSkillUpdateResult };
  }

  /** Installs the flow-diagram Skill from GitHub, approves it and enables it in the Project. */
  async function installFlow(): Promise<AgentSkillView> {
    publishFlow();
    const installed = await asPim<AgentSkillView>('POST', BASE, { url: FLOW_URL });
    expect(installed.status).toBe(201);
    const approved = await asPim<AgentSkillView>(
      'POST',
      `${BASE}/${installed.body.id}/versions/1/approve`,
    );
    expect(approved.status).toBe(200);
    const enabled = await asPim<AgentSkillView>('PUT', `${BASE}/${installed.body.id}/projects`, {
      projectIds: [PROJECT],
    });
    expect(enabled.status).toBe(200);
    return enabled.body;
  }

  const chatInputs = () =>
    ai.calls.filter((c) => c.method === 'chat').map((c) => c.input as ChatInput);

  function talk(content: string) {
    return asPim<ConversationView>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: FEATURE },
      content,
    });
  }

  /** The TOOL results of a Conversation, parsed. */
  async function toolResults(conversationId: string) {
    const rows = await db.conversationMessage.findMany({
      where: { conversationId, role: 'TOOL' },
      orderBy: { position: 'asc' },
    });
    return rows.map((r) => JSON.parse(r.content) as Record<string, unknown>);
  }

  const call = (name: string, args: unknown, id = `call-${name}`): ChatChunk => ({
    type: 'tool-call',
    call: { id, name, args },
  });
  const text = (delta: string): ChatChunk => ({ type: 'text', delta });

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'vorasaan-skills-'));
    process.env.FILE_STORAGE_DRIVER = 'local';
    process.env.FILE_STORAGE_LOCAL_DIR = storageDir;
    testApp = await createTestApp();
    ({ app, ai } = testApp);
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    await testApp.receipts.drain();
    await testApp.drainIndexing();
    await db.$disconnect();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testApp.receipts.drain();
    await testApp.drainIndexing();
    await truncateAll(db);
    await seed(db);
    await rm(join(storageDir, 'agent-skills'), { recursive: true, force: true });
    testApp.github.reset();
    ai.calls.length = 0;
    ai.chatScript.length = 0;
  });

  afterEach(() => {
    delete process.env.VORASAAN_AGENT_SKILL_MAX_FILE_BYTES;
    delete process.env.VORASAAN_AGENT_SKILL_MAX_BYTES;
  });

  // ─── Install ─────────────────────────────────────────────────────────────

  test('installs from a GitHub URL with a folder, pinned to the commit, waiting for approval', async () => {
    const sha = publishFlow();
    const res = await asPim<AgentSkillView>('POST', BASE, { url: FLOW_URL });
    expect(res.status).toBe(201);
    const skill = res.body;
    expect(skill).toMatchObject({
      name: 'flow-diagram',
      source: 'GITHUB',
      repository: 'acme/skills',
      ref: 'main',
      subpath: 'design/flow-diagram',
      sourceUrl: `https://github.com/acme/skills/tree/${sha}/design/flow-diagram`,
      active: null,
      projectIds: [],
    });
    expect(skill.pending).toMatchObject({
      number: 1,
      status: 'PENDING',
      pinned: sha,
      license: 'MIT',
    });
    expect(skill.pending?.files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'assets/template.svg',
      'references/style.md',
    ]);
    // Scripts, a binary and a link are listed as skipped, never stored.
    expect(skill.pending?.skipped).toEqual([
      { path: 'assets/latest', reason: 'LINK' },
      { path: 'assets/logo.png', reason: 'NOT_TEXT' },
      { path: 'scripts/build', reason: 'SCRIPT' },
      { path: 'scripts/render.py', reason: 'SCRIPT' },
    ]);
    // Stored through FileStorage, under keys the server chose: three files, no script.
    const keys = await storedKeys();
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(key).toStartWith(`agent-skills/${skill.id}/`);
    const stored = await Promise.all(
      keys.map(async (k) => new TextDecoder().decode(await storage().get(k))),
    );
    expect(stored.some((t) => t.includes('os.system'))).toBe(false);
    expect(stored).toContain(FLOW_DIAGRAM_SKILL_MD);
    // Only GitHub's API and download host were asked, at the resolved commit.
    expect(testApp.github.requests).toEqual([
      'https://api.github.com/repos/acme/skills/commits/main',
      `https://codeload.github.com/acme/skills/zip/${sha}`,
    ]);

    // The folder can also be given apart from the URL.
    await asPim('DELETE', `${BASE}/${skill.id}`);
    const bySubpath = await asPim<AgentSkillView>('POST', BASE, {
      url: 'https://github.com/acme/skills',
      subpath: 'design/flow-diagram',
    });
    expect(bySubpath.status).toBe(201);
    expect(bySubpath.body).toMatchObject({ ref: null, subpath: 'design/flow-diagram' });
    expect(bySubpath.body.pending?.pinned).toBe(sha);
  });

  test('installs from a zip, pinned to its SHA-256; a second Skill of the same name is refused', async () => {
    const zip = buildZip(inFolder('flow-diagram', flowDiagramFiles()));
    const res = await uploadZip(pim.id, `${BASE}/zip`, zip);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'flow-diagram', source: 'ZIP', repository: null });
    const expected = `sha256:${new Bun.CryptoHasher('sha256').update(zip).digest('hex')}`;
    expect(res.body.pending?.pinned).toBe(expected);
    expect(res.body.pending?.skipped.map((s) => s.path)).toContain('scripts/render.py');

    const again = await uploadZip(pim.id, `${BASE}/zip`, zip);
    expect(again.status).toBe(409);
    publishFlow();
    expect((await asPim('POST', BASE, { url: FLOW_URL })).status).toBe(409);

    // A zip of several Skills names one with its folder.
    const many = buildZip([
      ...inFolder('a', flowDiagramFiles({ 'SKILL.md': '---\nname: a\ndescription: A.\n---\n' })),
      ...inFolder('b', flowDiagramFiles({ 'SKILL.md': '---\nname: b\ndescription: B.\n---\n' })),
    ]);
    expect((await uploadZip(pim.id, `${BASE}/zip`, many)).status).toBe(422);
    const b = await uploadZip(pim.id, `${BASE}/zip`, many, 'b');
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ name: 'b', subpath: 'b' });
  });

  test('refuses plain http, other hosts, a redirect off GitHub, and a Skill or file over the limits', async () => {
    const sha = publishFlow();
    for (const url of [
      'http://github.com/acme/skills',
      'https://evil.example/acme/skills',
      'https://github.com.evil.example/acme/skills',
      'https://127.0.0.1/acme/skills',
    ]) {
      const res = await asPim<{ message: string }>('POST', BASE, { url });
      expect(res.status).toBe(422);
    }
    expect(testApp.github.requests).toEqual([]);

    testApp.github.redirect(
      `https://codeload.github.com/acme/skills/zip/${sha}`,
      'https://169.254.169.254/latest/meta-data/',
    );
    const redirected = await asPim<{ message: string }>('POST', BASE, { url: FLOW_URL });
    expect(redirected.status).toBe(422);
    expect(redirected.body.message).toContain('only GitHub is allowed');
    expect(testApp.github.requests.some((u) => u.includes('169.254'))).toBe(false);

    testApp.github.reset();
    publishFlow();
    process.env.VORASAAN_AGENT_SKILL_MAX_FILE_BYTES = '200';
    const file = await asPim<{ message: string }>('POST', BASE, { url: FLOW_URL });
    expect(file.status).toBe(413);
    expect(file.body.message).toContain('larger than 200 bytes');
    delete process.env.VORASAAN_AGENT_SKILL_MAX_FILE_BYTES;
    process.env.VORASAAN_AGENT_SKILL_MAX_BYTES = '600';
    const whole = await asPim<{ message: string }>('POST', BASE, { url: FLOW_URL });
    expect(whole.status).toBe(413);
    expect(whole.body.message).toContain('together');

    // Nothing refused left a Skill or a file behind.
    expect(await db.agentSkill.count()).toBe(0);
    expect(await storedKeys()).toEqual([]);
  });

  test('only an Admin installs, updates, approves, enables or uninstalls (403, nothing fetched or stored)', async () => {
    publishFlow();
    const zip = buildZip(flowDiagramFiles());
    const id = crypto.randomUUID();
    const tries = [
      () => asBeam('GET', BASE),
      () => asBeam('POST', BASE, { url: FLOW_URL }),
      () => uploadZip(beam.id, `${BASE}/zip`, zip),
      () => asBeam('GET', `${BASE}/${id}`),
      () => asBeam('POST', `${BASE}/${id}/update`),
      () => uploadZip(beam.id, `${BASE}/${id}/update/zip`, zip),
      () => asBeam('GET', `${BASE}/${id}/diff`),
      () => asBeam('POST', `${BASE}/${id}/versions/1/approve`),
      () => asBeam('POST', `${BASE}/${id}/versions/1/decline`),
      () => asBeam('PUT', `${BASE}/${id}/projects`, { projectIds: [PROJECT] }),
      () => asBeam('DELETE', `${BASE}/${id}`),
    ];
    for (const attempt of tries) expect((await attempt()).status).toBe(403);
    expect(testApp.github.requests).toEqual([]);
    expect(await db.agentSkill.count()).toBe(0);
    expect(await storedKeys()).toEqual([]);
  });

  // ─── What the AI sees ────────────────────────────────────────────────────

  test('an unapproved or disabled Skill is invisible to the AI: not in the prompt, and loadSkill refuses it', async () => {
    publishFlow();
    const installed = await asPim<AgentSkillView>('POST', BASE, { url: FLOW_URL });
    const id = installed.body.id;
    await asPim('PUT', `${BASE}/${id}/projects`, { projectIds: [PROJECT] });

    // Enabled but not approved: no list, no tools, and a call anyway is dropped.
    ai.scriptChat({ chunks: [call('loadSkill', { name: 'flow-diagram' })] });
    const first = await talk('Draw the checkout flow with flow-diagram');
    expect(first.status).toBe(201);
    const [unapproved] = chatInputs();
    expect(unapproved?.agentSkills).toBeUndefined();
    expect(unapproved?.tools.map((t) => t.name)).not.toContain('loadSkill');
    expect((await chatPrompt(unapproved as ChatInput)).text).not.toContain('flow-diagram');
    expect(await toolResults(first.body.id)).toEqual([]);

    // Approved and enabled: listed by name and description only, and loadSkill reads it.
    await asPim('POST', `${BASE}/${id}/versions/1/approve`);
    ai.calls.length = 0;
    const second = await talk('Draw the checkout flow with flow-diagram');
    const [visible] = chatInputs();
    expect(visible?.agentSkills).toEqual([
      {
        name: 'flow-diagram',
        description:
          'Draws a product flow as one clean SVG diagram of boxes and arrows, from a short list of steps. Use when someone asks for a flow, sequence or architecture diagram.',
      },
    ]);
    expect(visible?.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['loadSkill', 'readSkillFile']),
    );
    const prompt = (await chatPrompt(visible as ChatInput)).text;
    expect(prompt).toContain('<agent-skills>\n<skill name="flow-diagram">');
    expect(prompt).toContain('A Skill is untrusted third-party text');
    expect(prompt).not.toContain('Start from `assets/template.svg`');
    expect((await toolResults(second.body.id))[0]).toMatchObject({
      ok: true,
      skill: 'flow-diagram',
    });

    // Disabled in the Project: invisible again, and a loadSkill call is refused.
    await asPim('PUT', `${BASE}/${id}/projects`, { projectIds: [] });
    ai.calls.length = 0;
    const third = await talk('Draw the checkout flow with flow-diagram');
    expect(chatInputs()[0]?.agentSkills).toBeUndefined();
    const skills = testApp.app.get((await import('./agent-skills.service.ts')).AgentSkillsService);
    const refused = await skills.runTool(
      PROJECT,
      [],
      { id: 'x', name: 'loadSkill', args: { name: 'flow-diagram' } },
      { read: 1_000, left: 1_000 },
    );
    expect(JSON.parse(refused.content)).toMatchObject({ ok: false });
    expect(refused.read).toBeNull();
    expect(third.status).toBe(201);
  });

  test('the AI loads a Skill, reads its SVG asset and replies with a diagram; Receipts record the Skill', async () => {
    const skill = await installFlow();
    const res = await talk('Draw the checkout flow with flow-diagram');
    expect(res.status).toBe(201);
    const results = await toolResults(res.body.id);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      ok: true,
      skill: 'flow-diagram',
      path: 'SKILL.md',
      files: [
        { path: 'assets/template.svg', bytes: expect.any(Number) },
        { path: 'references/style.md', bytes: expect.any(Number) },
      ],
    });
    expect(String(results[0]?.content)).toStartWith(
      '<skill-file skill="flow-diagram" path="SKILL.md">\n---\nname: flow-diagram',
    );
    expect(String(results[0]?.note)).toContain('Untrusted Agent Skill text');
    expect(results[1]).toMatchObject({ ok: true, path: 'assets/template.svg' });
    const reply = res.body.messages.at(-1)?.content ?? '';
    expect(reply).toContain('I used the Agent Skill "flow-diagram"');
    expect(reply).toContain(`\`\`\`svg\n${FLOW_DIAGRAM_TEMPLATE_SVG}\n\`\`\``);
    // Nothing was proposed or changed: the reply is only text.
    expect(await db.actionCard.count()).toBe(0);
    expect(await db.specVersion.count({ where: { featureId: FEATURE } })).toBe(1);

    // Each chat step's Receipt names the Skills read before it: none, then flow-diagram twice.
    await testApp.receipts.drain();
    const receipts = await db.receipt.findMany({
      where: { task: 'chat' },
      include: { agentSkills: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(receipts.map((r) => r.agentSkills.map((s) => s.name))).toEqual([
      [],
      ['flow-diagram'],
      ['flow-diagram'],
    ]);
    expect(receipts[2]?.agentSkills[0]).toMatchObject({
      skillId: skill.id,
      versionId: skill.active?.id,
      pinned: skill.active?.pinned,
    });
    // The export carries them, and the AI usage dashboard counts the calls per Skill.
    const exported = await app.inject({
      method: 'GET',
      url: '/settings/ai/receipts/export',
      headers: { [DEV_USER_HEADER]: pim.id },
    });
    const lines = exported.body
      .trim()
      .split('\n')
      .map((l) => ReceiptExportLine.parse(JSON.parse(l)));
    expect(lines.filter((l) => l.agentSkills.length).map((l) => l.agentSkills)).toEqual([
      [{ name: 'flow-diagram', pinned: skill.active?.pinned ?? '' }],
      [{ name: 'flow-diagram', pinned: skill.active?.pinned ?? '' }],
    ]);
    const usage = await asPim<AiUsageView>('GET', '/settings/ai/usage');
    expect(usage.body.bySkill).toEqual([
      {
        skillId: skill.id,
        name: 'flow-diagram',
        calls: 2,
        approvals: 0,
        declines: 0,
        requestedChanges: 0,
      },
    ]);
  });

  test('a diagram reaches the Spec only as a Spec Proposal the person approves', async () => {
    await installFlow();
    const svgBlock = `\`\`\`svg\n${FLOW_DIAGRAM_TEMPLATE_SVG}\n\`\`\``;
    const spec = (await asPim<SpecVersionView[]>('GET', `/features/${FEATURE}/spec-versions`))
      .body[0];
    ai.scriptChat(
      { chunks: [call('loadSkill', { name: 'flow-diagram' })] },
      {
        chunks: [
          call('draftSpecProposal', {
            proposedMarkdown: `${spec?.markdown}\n## Flow\n\n${svgBlock}\n`,
            summary: 'Add the checkout flow diagram',
          }),
        ],
      },
      { chunks: [text('I drafted a Spec Proposal with the diagram; it waits for your approval.')] },
    );
    const res = await talk('Add the flow-diagram of checkout to the Spec');
    expect(res.status).toBe(201);
    const card = res.body.actionCards?.[0] as ActionCardView;
    expect(card).toMatchObject({ kind: 'SPEC_PROPOSAL', status: 'PROPOSED' });
    expect(await db.specVersion.count({ where: { featureId: FEATURE } })).toBe(1);
    // Its Receipt (the step that drafted it) names the Skill read before it.
    await testApp.receipts.drain();
    const drafting = await db.receipt.findMany({
      where: { task: 'chat' },
      include: { agentSkills: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(drafting[1]?.agentSkills.map((s) => s.name)).toEqual(['flow-diagram']);

    const approved = await asPim('POST', `/action-cards/${card.id}/approve`, {});
    expect(approved.status).toBe(201);
    const latest = (await asPim<SpecVersionView[]>('GET', `/features/${FEATURE}/spec-versions`))
      .body[0];
    expect(latest?.markdown).toContain(svgBlock);
    // The approval is an outcome of the Receipt that drafted it, counted for the Skill.
    await testApp.receipts.drain();
    const usage = await asPim<AiUsageView>('GET', '/settings/ai/usage');
    expect(usage.body.bySkill[0]).toMatchObject({ name: 'flow-diagram', approvals: 1 });
  });

  test('loadSkill and readSkillFile read only inside enabled Skills; traversal and absolute paths are refused', async () => {
    await installFlow();
    // A second Skill, approved but not enabled in the Project.
    const other = await uploadZip(
      pim.id,
      `${BASE}/zip`,
      buildZip([
        { path: 'SKILL.md', data: '---\nname: secret\ndescription: Not here.\n---\nTOP SECRET' },
      ]),
    );
    await asPim('POST', `${BASE}/${other.body.id}/versions/1/approve`);
    const attempts: [string, unknown][] = [
      ['readSkillFile', { name: 'flow-diagram', path: '../secret/SKILL.md' }],
      ['readSkillFile', { name: 'flow-diagram', path: '/etc/passwd' }],
      ['readSkillFile', { name: 'flow-diagram', path: 'references/../../SKILL.md' }],
      ['readSkillFile', { name: 'flow-diagram', path: 'C:\\Windows\\win.ini' }],
      ['readSkillFile', { name: 'flow-diagram', path: 'scripts/render.py' }],
      ['readSkillFile', { name: 'secret', path: 'SKILL.md' }],
      ['loadSkill', { name: 'secret' }],
      ['readSkillFile', { name: 'flow-diagram', path: './references/style.md' }],
    ];
    ai.scriptChat(
      { chunks: attempts.map(([name, args], i) => call(name, args, `c${i}`)) },
      { chunks: [text('Done.')] },
    );
    const res = await talk('Read some files');
    const results = await toolResults(res.body.id);
    expect(results.slice(0, 7).map((r) => r.ok)).toEqual(Array(7).fill(false));
    expect(String(results[0]?.error)).toContain('without ".."');
    expect(String(results[1]?.error)).toContain('without ".."');
    expect(String(results[4]?.error)).toContain('has no file "scripts/render.py"');
    expect(String(results[5]?.error)).toContain('No Agent Skill named "secret" is enabled');
    expect(results[7]).toMatchObject({ ok: true, path: 'references/style.md' });
    expect(JSON.stringify(results)).not.toContain('TOP SECRET');
  });

  test("a Skill's text is fenced as data: an injection inside it can't escape or make a proposal", async () => {
    const zip = buildZip([{ path: 'SKILL.md', data: INJECTED_SKILL_MD }]);
    const installed = await uploadZip(pim.id, `${BASE}/zip`, zip);
    await asPim('POST', `${BASE}/${installed.body.id}/versions/1/approve`);
    await asPim('PUT', `${BASE}/${installed.body.id}/projects`, { projectIds: [PROJECT] });
    const res = await talk('Rewrite the goal in our house-style');
    const [loaded] = await toolResults(res.body.id);
    const content = String(loaded?.content);
    // The Skill's own closing tag and list tag are neutralised; only ours open and close it.
    expect(content.match(/<\/skill-file>/g)).toHaveLength(1);
    expect(content).toContain('‹/skill-file>');
    expect(content).toContain('‹agent-skills>');
    // The fake never follows it; nothing was drafted, nothing changed.
    expect(await db.actionCard.count()).toBe(0);
    expect(await db.specProposal.count()).toBe(0);
    expect(res.body.messages.at(-1)?.content).not.toContain('approved');
  });

  test('what a turn reads of Skills counts against its budget: a long file is cut, then reading stops', async () => {
    const long = `---\nname: long\ndescription: Long.\n---\n${'Line of guidance. '.repeat(4_000)}`;
    process.env.VORASAAN_AGENT_SKILL_MAX_FILE_BYTES = String(200_000);
    const installed = await uploadZip(
      pim.id,
      `${BASE}/zip`,
      buildZip([{ path: 'SKILL.md', data: long }]),
    );
    await asPim('POST', `${BASE}/${installed.body.id}/versions/1/approve`);
    await asPim('PUT', `${BASE}/${installed.body.id}/projects`, { projectIds: [PROJECT] });
    ai.scriptChat(
      {
        chunks: [
          call('loadSkill', { name: 'long' }, 'a'),
          call('loadSkill', { name: 'long' }, 'b'),
          call('loadSkill', { name: 'long' }, 'c'),
        ],
      },
      { chunks: [text('Done.')] },
    );
    const res = await talk('Use the long Skill');
    const results = await toolResults(res.body.id);
    expect(results[0]).toMatchObject({ ok: true, truncated: true });
    expect(String(results[0]?.content).length).toBeLessThan(long.length);
    expect(results[1]).toMatchObject({ ok: true, truncated: true });
    expect(results[2]).toMatchObject({ ok: false });
    expect(String(results[2]?.error)).toContain('context budget');
  });

  // ─── Update, approve, uninstall ──────────────────────────────────────────

  test('Update fetches the newer commit and shows a diff; nothing changes until it is approved', async () => {
    const skill = await installFlow();
    const v1 = skill.active?.pinned;
    // Up to date: nothing new.
    const same = await asPim<AgentSkillUpdateResult>('POST', `${BASE}/${skill.id}/update`);
    expect(same.body.upToDate).toBe(true);
    expect(same.body.skill.pending).toBeNull();

    const v2 = publishFlow({
      'references/style.md': '# Style\n\n- Boxes: 140 × 48.\n',
      'SKILL.md': FLOW_DIAGRAM_SKILL_MD.replace('One box per step', 'One rounded box per step'),
    });
    const updated = await asPim<AgentSkillUpdateResult>('POST', `${BASE}/${skill.id}/update`);
    expect(updated.status).toBe(200);
    expect(updated.body.upToDate).toBe(false);
    expect(updated.body.skill.active?.pinned).toBe(v1);
    expect(updated.body.skill.pending).toMatchObject({ number: 2, status: 'PENDING', pinned: v2 });

    const diff = await asPim<AgentSkillDiff>('GET', `${BASE}/${skill.id}/diff`);
    expect(diff.body).toMatchObject({ from: 1, to: 2 });
    expect(diff.body.files.map((f) => [f.path, f.change])).toEqual([
      ['SKILL.md', 'CHANGED'],
      ['assets/template.svg', 'UNCHANGED'],
      ['references/style.md', 'CHANGED'],
    ]);
    const lines = diff.body.files[0]?.lines ?? [];
    expect(lines).toContainEqual(
      expect.objectContaining({
        kind: 'REMOVED',
        text: '3. One box per step, left to right; arrows between consecutive steps.',
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        kind: 'ADDED',
        text: '3. One rounded box per step, left to right; arrows between consecutive steps.',
      }),
    );
    // A second update waits for the first to be decided.
    expect((await asPim('POST', `${BASE}/${skill.id}/update`)).status).toBe(409);

    // Until approved, the AI still reads version 1.
    ai.scriptChat(
      { chunks: [call('loadSkill', { name: 'flow-diagram' })] },
      { chunks: [text('ok')] },
    );
    const before = await talk('Read flow-diagram');
    expect(String((await toolResults(before.body.id))[0]?.content)).toContain(
      '3. One box per step',
    );

    const approved = await asPim<AgentSkillView>('POST', `${BASE}/${skill.id}/versions/2/approve`);
    expect(approved.body.active).toMatchObject({ number: 2, pinned: v2, status: 'APPROVED' });
    expect(approved.body.pending).toBeNull();
    // Version 1 is replaced and its files deleted; version 2's three remain.
    expect(await db.agentSkillVersion.findFirst({ where: { number: 1 } })).toMatchObject({
      status: 'REPLACED',
    });
    expect(await storedKeys()).toHaveLength(3);
    expect((await asPim('POST', `${BASE}/${skill.id}/versions/2/approve`)).status).toBe(409);

    ai.scriptChat(
      { chunks: [call('loadSkill', { name: 'flow-diagram' })] },
      { chunks: [text('ok')] },
    );
    const after = await talk('Read flow-diagram');
    expect(String((await toolResults(after.body.id))[0]?.content)).toContain(
      '3. One rounded box per step',
    );

    // A declined update changes nothing and deletes its files.
    publishFlow({ 'references/style.md': '# Style\n\n- Changed again.\n' });
    await asPim('POST', `${BASE}/${skill.id}/update`);
    const declined = await asPim<AgentSkillView>('POST', `${BASE}/${skill.id}/versions/3/decline`);
    expect(declined.body.active?.number).toBe(2);
    expect(declined.body.pending).toBeNull();
    expect(await storedKeys()).toHaveLength(3);
  });

  test('a zip-installed Skill updates from a new zip, with its diff', async () => {
    const first = await uploadZip(pim.id, `${BASE}/zip`, buildZip(flowDiagramFiles()));
    await asPim('POST', `${BASE}/${first.body.id}/versions/1/approve`);
    const same = await uploadZip(
      pim.id,
      `${BASE}/${first.body.id}/update/zip`,
      buildZip(flowDiagramFiles()),
    );
    expect(same.status).toBe(200);
    expect(same.body.upToDate).toBe(true);
    const next = buildZip(flowDiagramFiles({ 'references/style.md': '# Style\n\nNew.\n' }));
    const updated = await uploadZip(pim.id, `${BASE}/${first.body.id}/update/zip`, next);
    expect(updated.body.upToDate).toBe(false);
    expect(updated.body.skill.pending?.number).toBe(2);
    const diff = await asPim<AgentSkillDiff>('GET', `${BASE}/${first.body.id}/diff`);
    expect(diff.body.files.find((f) => f.path === 'references/style.md')?.change).toBe('CHANGED');
    // A GitHub Skill doesn't take a zip, and the other way round.
    expect((await asPim('POST', `${BASE}/${first.body.id}/update`)).status).toBe(422);
  });

  test('on a first install the diff lists every file as added', async () => {
    publishFlow();
    const installed = await asPim<AgentSkillView>('POST', BASE, { url: FLOW_URL });
    const diff = await asPim<AgentSkillDiff>('GET', `${BASE}/${installed.body.id}/diff`);
    expect(diff.body.from).toBeNull();
    expect(diff.body.files.map((f) => f.change)).toEqual(['ADDED', 'ADDED', 'ADDED']);
    expect(diff.body.files[0]?.lines[0]).toMatchObject({ kind: 'ADDED', text: '---' });
    expect(diff.body.skipped).toHaveLength(4);
    const list = await asPim<AgentSkillsView>('GET', BASE);
    expect(list.body.skills.map((s) => s.name)).toEqual(['flow-diagram']);
    expect(list.body.projects.map((p) => p.id)).toContain(PROJECT);
    expect(list.body.limits.maxFileBytes).toBe(256 * 1024);
  });

  test('uninstall removes the Skill and its files; Receipts keep its name', async () => {
    const skill = await installFlow();
    await talk('Draw the checkout flow with flow-diagram');
    await testApp.receipts.drain();
    const res = await asPim('DELETE', `${BASE}/${skill.id}`);
    expect(res.status).toBe(204);
    expect(await db.agentSkill.count()).toBe(0);
    expect(await db.agentSkillVersion.count()).toBe(0);
    expect(await db.agentSkillFile.count()).toBe(0);
    expect(await db.projectAgentSkill.count()).toBe(0);
    expect(await storedKeys()).toEqual([]);
    expect(await db.receiptAgentSkill.count({ where: { skillId: skill.id } })).toBe(2);
    // The AI no longer sees it.
    ai.calls.length = 0;
    await talk('Draw the checkout flow with flow-diagram');
    expect(chatInputs()[0]?.agentSkills).toBeUndefined();
    expect((await asPim('DELETE', `${BASE}/${skill.id}`)).status).toBe(404);
  });

  test("the fake's turn in Thai uses the Skill and answers in Thai", async () => {
    await installFlow();
    const res = await talk('ช่วยวาดแผนภาพขั้นตอนการชำระเงินให้หน่อย');
    const reply = res.body.messages.at(-1)?.content ?? '';
    expect(reply).toStartWith('ผมใช้ Agent Skill "flow-diagram"');
    expect(reply).toContain('```svg');
    const messages: ChatMessageForAi[] = chatInputs().at(-1)?.recentMessages ?? [];
    expect(messages.filter((m) => m.role === 'TOOL')).toHaveLength(2);
  });
});
