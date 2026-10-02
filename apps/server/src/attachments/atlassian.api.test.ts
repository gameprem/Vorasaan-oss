import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AtlassianSettingsView,
  AtlassianTestResult,
  AttachmentView,
  FeatureView,
} from '@vorasaan/shared';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';
import { TRUNCATION_MARKER } from './snapshot-text.ts';

const { pim, beam } = SEED.users;
const featureUrl = `/features/${SEED.featureId}/attachments`;

const EMAIL = 'pim@acme.test';
const TOKEN = 'atl-super-secret-token-7788';
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

type Hit = { path: string; authorization: string | null };

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A Jira Cloud description in Atlassian Document Format. */
const ADF = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Poll the provider every ' },
        { type: 'text', text: '30 s', marks: [{ type: 'strong' }] },
        { type: 'text', text: '.' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Ask ' },
        { type: 'mention', attrs: { id: 'x', text: '@Beam' } },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'No webhooks' }] }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retry twice' }] }],
        },
      ],
    },
  ],
};

describe('Confluence and Jira Attachments', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  /** The fake Atlassian site. */
  let site: ReturnType<typeof Bun.serve>;
  /** Another host: it must never see a request, let alone the credentials. */
  let elsewhere: ReturnType<typeof Bun.serve>;
  let siteHits: Hit[];
  let elsewhereHits: Hit[];
  let pageHtml: string;
  let issueStatus: string;
  let siteUrl: string;

  /** Every response body, to prove the token never comes back. */
  const bodies: string[] = [];
  const record =
    (actor: ReturnType<typeof as>): ReturnType<typeof as> =>
    async (method, url, body) => {
      const res = await actor(method, url, body);
      bodies.push(JSON.stringify(res.body ?? null));
      return res as never;
    };

  const connect = (overrides: Record<string, unknown> = {}) =>
    asPim<AtlassianSettingsView>('PUT', '/settings/atlassian', {
      siteUrl,
      email: EMAIL,
      apiToken: TOKEN,
      ...overrides,
    });

  beforeAll(async () => {
    process.env.ATLASSIAN_ALLOW_HTTP = 'true';
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        siteHits.push({
          path: url.pathname + url.search,
          authorization: req.headers.get('authorization'),
        });
        if (req.headers.get('authorization') !== BASIC) {
          return json({ message: 'Client must be authenticated' }, 401);
        }
        if (url.pathname === '/rest/api/3/myself') return json({ displayName: 'Pim' });
        if (url.pathname === '/wiki/rest/api/content/4242') {
          return json({
            id: '4242',
            title: 'Checkout design',
            body: { view: { value: pageHtml } },
          });
        }
        if (url.pathname === '/wiki/rest/api/content/666') {
          return new Response(null, {
            status: 302,
            headers: { location: `${elsewhere.url}steal` },
          });
        }
        if (url.pathname === '/rest/api/3/issue/MB-42') {
          return json({
            key: 'MB-42',
            fields: { summary: 'Async checkout', status: { name: issueStatus }, description: ADF },
          });
        }
        return json({ errorMessages: ['Not found'] }, 404);
      },
    });
    elsewhere = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        elsewhereHits.push({
          path: new URL(req.url).pathname,
          authorization: req.headers.get('authorization'),
        });
        return json({ title: 'stolen', body: { view: { value: 'stolen' } } });
      },
    });
    siteUrl = `http://127.0.0.1:${site.port}`;
    ({ app } = await createTestApp());
    db = createTestPrisma();
    asPim = record(as(app, pim.id));
    asBeam = record(as(app, beam.id));
  });

  afterAll(async () => {
    delete process.env.ATLASSIAN_ALLOW_HTTP;
    delete process.env.ATTACHMENT_SNAPSHOT_MAX_CHARS;
    // No response, from any test in this file, ever contained the token.
    for (const body of bodies) expect(body).not.toContain(TOKEN);
    expect(elsewhereHits).toEqual([]);
    site.stop(true);
    elsewhere.stop(true);
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    siteHits = [];
    elsewhereHits = [];
    delete process.env.ATTACHMENT_SNAPSHOT_MAX_CHARS;
    pageHtml =
      '<h2>Polling</h2><p>Poll every <strong>30 s</strong>.</p><ul><li>No webhooks</li></ul>';
    issueStatus = 'In Progress';
  });

  // ─── Settings ───────────────────────────────────────────────────────────

  test('settings start empty; only Admins read, save or test them', async () => {
    const empty = await asPim<AtlassianSettingsView>('GET', '/settings/atlassian');
    expect(empty.body).toEqual({
      configured: false,
      siteUrl: null,
      email: null,
      apiTokenSet: false,
    });

    const body = { siteUrl, email: EMAIL, apiToken: TOKEN };
    expect((await asBeam('GET', '/settings/atlassian')).status).toBe(403);
    expect((await asBeam('PUT', '/settings/atlassian', body)).status).toBe(403);
    expect((await asBeam('POST', '/settings/atlassian/test', body)).status).toBe(403);
    expect(siteHits).toEqual([]);
  });

  test('saving stores the token encrypted and never returns it; editing keeps it', async () => {
    const saved = await connect({ siteUrl: `${siteUrl}/wiki/home` });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ configured: true, siteUrl, email: EMAIL, apiTokenSet: true });
    const stored = await db.orgIntegration.findFirstOrThrow({ where: { provider: 'ATLASSIAN' } });
    expect(stored.secretEncrypted).not.toContain(TOKEN);
    expect(stored.baseUrl).toBe(siteUrl);

    // Changing the email without re-typing the token keeps the stored one.
    const edited = await connect({ email: 'po@acme.test', apiToken: undefined });
    expect(edited.status).toBe(200);
    expect(edited.body.email).toBe('po@acme.test');
    await connect({ apiToken: undefined });
    expect(
      (
        await asPim<AtlassianTestResult>('POST', '/settings/atlassian/test', {
          siteUrl,
          email: EMAIL,
        })
      ).body.ok,
    ).toBe(true);

    // The stored token is never reused for another site.
    const moved = await connect({ siteUrl: `http://localhost:${site.port}`, apiToken: undefined });
    expect(moved.status).toBe(422);
    expect(JSON.stringify(moved.body)).toContain('API token again');
    const probe = await asPim<AtlassianTestResult>('POST', '/settings/atlassian/test', {
      siteUrl: `http://127.0.0.1:${elsewhere.port}`,
      email: EMAIL,
    });
    expect(probe.body.ok).toBe(false);
    expect(elsewhereHits).toEqual([]);
  });

  test('the site must use https unless ATLASSIAN_ALLOW_HTTP is on', async () => {
    delete process.env.ATLASSIAN_ALLOW_HTTP;
    try {
      const refused = await connect();
      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain('https://');
    } finally {
      process.env.ATLASSIAN_ALLOW_HTTP = 'true';
    }
    expect((await connect({ siteUrl: 'ftp://acme.atlassian.net' })).status).toBe(400);
    expect((await connect({ email: 'not-an-email' })).status).toBe(400);
  });

  test('test connection reports the account, or why it failed, without saving', async () => {
    const ok = await asPim<AtlassianTestResult>('POST', '/settings/atlassian/test', {
      siteUrl,
      email: EMAIL,
      apiToken: TOKEN,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, message: `Connected to 127.0.0.1:${site.port} as Pim` });
    expect(siteHits).toEqual([{ path: '/rest/api/3/myself', authorization: BASIC }]);
    expect(await db.orgIntegration.count()).toBe(0);

    const wrong = await asPim<AtlassianTestResult>('POST', '/settings/atlassian/test', {
      siteUrl,
      email: EMAIL,
      apiToken: 'wrong-token',
    });
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.message).toContain('HTTP 401');
    expect(wrong.body.message).not.toContain('wrong-token');
  });

  // ─── Attachments ────────────────────────────────────────────────────────

  test('without the integration, Confluence and Jira Attachments are a clear 422', async () => {
    for (const body of [
      { source: 'CONFLUENCE', page: '4242' },
      { source: 'JIRA', issue: 'MB-42' },
    ]) {
      const res = await asBeam<{ message: string }>('POST', featureUrl, body);
      expect(res.status).toBe(422);
      expect(res.body.message).toContain('Atlassian is not connected');
    }
    expect(siteHits).toEqual([]);
    expect(await db.attachment.count()).toBe(0);
  });

  test('a Confluence page snapshots its title and body; refresh re-fetches it', async () => {
    await connect();
    const created = await asBeam<AttachmentView>('POST', featureUrl, {
      source: 'CONFLUENCE',
      page: `${siteUrl}/wiki/spaces/MB/pages/4242/Checkout+design`,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      source: 'CONFLUENCE',
      title: 'Checkout design',
      url: `${siteUrl}/wiki/pages/viewpage.action?pageId=4242`,
      mimeType: null,
      hasFile: false,
      snapshotText: '# Checkout design\n\n## Polling\n\nPoll every 30 s.\n\n- No webhooks',
    });
    expect(siteHits).toEqual([
      { path: '/wiki/rest/api/content/4242?expand=body.view,body.storage', authorization: BASIC },
    ]);

    pageHtml = '<p>Webhooks are now supported.</p>';
    const refreshed = await asPim<AttachmentView>(
      'POST',
      `/attachments/${created.body.id}/refresh`,
    );
    expect(refreshed.status).toBe(201);
    expect(refreshed.body.snapshotText).toBe('# Checkout design\n\nWebhooks are now supported.');

    // By page id, with a title; the Snapshot cap applies.
    process.env.ATTACHMENT_SNAPSHOT_MAX_CHARS = '8';
    const byId = await asBeam<AttachmentView>('POST', featureUrl, {
      source: 'CONFLUENCE',
      page: '4242',
      title: 'Design',
    });
    expect(byId.body.title).toBe('Design');
    expect(byId.body.snapshotText).toBe(`# Checko${TRUNCATION_MARKER}`);

    const missing = await asBeam<{ message: string }>('POST', featureUrl, {
      source: 'CONFLUENCE',
      page: '1',
    });
    expect(missing.status).toBe(422);
    expect(missing.body.message).toContain('Confluence page 1 was not found');
  });

  test('a Jira issue snapshots key, summary, status and description', async () => {
    await connect();
    const created = await asBeam<AttachmentView>('POST', featureUrl, {
      source: 'JIRA',
      issue: 'mb-42',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      source: 'JIRA',
      title: 'MB-42: Async checkout',
      url: `${siteUrl}/browse/MB-42`,
      snapshotText:
        'MB-42: Async checkout\nStatus: In Progress\n\n' +
        'Poll the provider every 30 s.\nAsk @Beam\n\n- No webhooks\n- Retry twice',
    });
    expect(siteHits.map((h) => h.path)).toEqual([
      '/rest/api/3/issue/MB-42?fields=summary,status,description',
    ]);

    issueStatus = 'Done';
    const refreshed = await asBeam<AttachmentView>(
      'POST',
      `/attachments/${created.body.id}/refresh`,
    );
    expect(refreshed.body.snapshotText).toContain('Status: Done');

    const byUrl = await asBeam<AttachmentView>('POST', featureUrl, {
      source: 'JIRA',
      issue: `${siteUrl}/browse/MB-42`,
    });
    expect(byUrl.status).toBe(201);
    expect(byUrl.body.url).toBe(`${siteUrl}/browse/MB-42`);

    const bad = await asBeam<{ message: string }>('POST', featureUrl, {
      source: 'JIRA',
      issue: 'not a key',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toContain('Jira issue key');
  });

  test('credentials only go to the configured site: other hosts and redirects are refused', async () => {
    await connect();
    for (const body of [
      { source: 'CONFLUENCE', page: `${elsewhere.url}wiki/spaces/MB/pages/4242/X` },
      { source: 'CONFLUENCE', page: `http://localhost:${site.port}/wiki/spaces/MB/pages/4242/X` },
      {
        source: 'CONFLUENCE',
        page: `http://127.0.0.1:${site.port}@127.0.0.1:${elsewhere.port}/wiki/pages/4242`,
      },
      { source: 'JIRA', issue: `${elsewhere.url}browse/MB-42` },
    ]) {
      const res = await asBeam<{ message: string }>('POST', featureUrl, body);
      expect(res.status).toBe(422);
      expect(res.body.message).toContain(`must be on 127.0.0.1:${site.port}`);
    }
    expect(siteHits).toEqual([]);

    // The site redirecting elsewhere is not followed.
    const redirected = await asBeam<{ message: string }>('POST', featureUrl, {
      source: 'CONFLUENCE',
      page: '666',
    });
    expect(redirected.status).toBe(422);
    expect(redirected.body.message).toContain('redirect');
    expect(elsewhereHits).toEqual([]);
  });

  test('URL Attachments still work with or without an explicit source', async () => {
    const unknown = await asBeam('POST', featureUrl, { source: 'FIGMA', url: siteUrl });
    expect(unknown.status).toBe(400);
    const noPage = await asBeam('POST', featureUrl, { source: 'CONFLUENCE' });
    expect(noPage.status).toBe(400);
  });

  // ─── Feature → Jira Epic ────────────────────────────────────────────────

  test('a Feature links a Jira Epic, shown as a link once Atlassian is connected', async () => {
    const feature = `/features/${SEED.featureId}`;
    const set = await asPim<{ jiraIssueKey: string }>('PATCH', feature, { jiraIssueKey: 'mb-7' });
    expect(set.status).toBe(200);
    expect(set.body.jiraIssueKey).toBe('MB-7');
    expect((await asPim<FeatureView>('GET', feature)).body).toMatchObject({
      jiraIssueKey: 'MB-7',
      jiraIssueUrl: null,
    });

    await connect();
    expect((await asPim<FeatureView>('GET', feature)).body.jiraIssueUrl).toBe(
      `${siteUrl}/browse/MB-7`,
    );

    expect((await asPim('PATCH', feature, { jiraIssueKey: 'MB 7' })).status).toBe(400);
    expect((await asBeam('PATCH', feature, { jiraIssueKey: 'MB-8' })).status).toBe(403);

    const cleared = await asPim<{ jiraIssueKey: string | null }>('PATCH', feature, {
      jiraIssueKey: null,
    });
    expect(cleared.body.jiraIssueKey).toBeNull();
    expect((await asPim<FeatureView>('GET', feature)).body).toMatchObject({
      jiraIssueKey: null,
      jiraIssueUrl: null,
    });
  });
});
