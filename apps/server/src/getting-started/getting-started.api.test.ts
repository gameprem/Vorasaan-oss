import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import {
  type CreatedAccessToken,
  type CreatedInvitation,
  type GettingStartedItemKey,
  type GettingStartedView,
  type LoginResult,
  type OrganizationSettingsView,
  SETUP_TOKEN_HEADER,
} from '@vorasaan/shared';
import { SetupTokenService } from '../setup/setup-token.service.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';

describe('Getting started and the Organization language (ticket 0063)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;

  const call = async <T>(method: string, url: string, token?: string, payload?: object) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload ? { payload } : {}),
    });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };

  /** A fresh install set up by Nok, the first Admin. Returns Nok's session token. */
  async function setUp(): Promise<{ admin: string }> {
    const token = app.get(SetupTokenService).arm() as string;
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      headers: { [SETUP_TOKEN_HEADER]: token },
      payload: {
        organizationName: 'Acme Bank',
        admin: { name: 'Nok', email: 'nok@acme.test', password: 'long-enough-pass' },
        ai: { provider: 'ANTHROPIC', model: 'claude-opus-5-5', apiKey: 'sk-ant-x' },
      },
    });
    const body = res.json() as LoginResult;
    return { admin: body.token };
  }

  /** Invites someone and accepts as them; returns their session token. */
  async function join(admin: string, email: string, role?: 'ADMIN'): Promise<string> {
    const invite = await call<CreatedInvitation>('POST', '/invitations', admin, {
      email,
      ...(role && { role }),
    });
    const accepted = await call<LoginResult>('POST', `/invite/${invite.body.token}`, undefined, {
      name: email.split('@')[0],
      password: 'long-enough-pass',
    });
    return accepted.body.token;
  }

  const checklist = (token: string) =>
    call<GettingStartedView>('GET', '/me/getting-started', token);
  const done = (view: GettingStartedView) =>
    Object.fromEntries(view.items.map((i) => [i.key, i.done])) as Record<
      GettingStartedItemKey,
      boolean
    >;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(() => truncateAll(db));

  test('right after setup nothing is done, in order, and only the chat app is optional', async () => {
    const { admin } = await setUp();
    const { status, body } = await checklist(admin);
    expect(status).toBe(200);
    expect(body).toEqual({
      items: [
        { key: 'PROJECT_AND_TEAM', done: false, optional: false },
        { key: 'FEATURE_WITH_SPEC', done: false, optional: false },
        { key: 'INVITE_MEMBERS', done: false, optional: false },
        { key: 'LINK_CLI', done: false, optional: false },
        { key: 'CHAT_APP', done: false, optional: true },
      ],
      complete: false,
      dismissed: false,
    });
  });

  test('each item ticks itself as the thing is done, and the checklist completes without a chat app', async () => {
    const { admin } = await setUp();

    // A Project alone isn't enough: it needs a Team.
    const project = await call<{ id: string }>('POST', '/projects', admin, { name: 'Mobile' });
    expect(done((await checklist(admin)).body).PROJECT_AND_TEAM).toBe(false);
    const team = await call<{ id: string }>('POST', `/projects/${project.body.id}/teams`, admin, {
      name: 'Checkout',
    });
    expect(done((await checklist(admin)).body).PROJECT_AND_TEAM).toBe(true);

    // A Feature without a Spec isn't enough.
    const feature = await call<{ id: string }>('POST', `/teams/${team.body.id}/features`, admin, {
      title: 'Pay by QR',
    });
    expect(done((await checklist(admin)).body).FEATURE_WITH_SPEC).toBe(false);
    const spec = await call('POST', `/features/${feature.body.id}/spec-versions`, admin, {
      markdown: '# Pay by QR\n\nScan and pay.',
      baseVersion: 0,
    });
    expect(spec.status).toBe(201);
    expect(done((await checklist(admin)).body).FEATURE_WITH_SPEC).toBe(true);

    // An invitation counts once it is accepted.
    const pending = await call<CreatedInvitation>('POST', '/invitations', admin, {
      email: 'fern@acme.test',
    });
    expect(pending.status).toBe(201);
    expect(done((await checklist(admin)).body).INVITE_MEMBERS).toBe(false);
    const beam = await join(admin, 'beam@acme.test');
    expect(done((await checklist(admin)).body).INVITE_MEMBERS).toBe(true);

    // An Access token counts once the CLI has used it, and only the viewer's own.
    const beamsToken = await call<CreatedAccessToken>('POST', '/me/tokens', beam, { name: 'CLI' });
    await call('GET', '/me', beamsToken.body.token);
    const created = await call<CreatedAccessToken>('POST', '/me/tokens', admin, { name: 'CLI' });
    let view = (await checklist(admin)).body;
    expect(done(view).LINK_CLI).toBe(false);
    await call('GET', '/me', created.body.token); // what `vorasaan login` does
    view = (await checklist(admin)).body;
    expect(done(view).LINK_CLI).toBe(true);
    expect(view.complete).toBe(true);
    expect(done(view).CHAT_APP).toBe(false);

    // Revoking the token unlinks the CLI again.
    await call('DELETE', `/me/tokens/${created.body.id}`, admin);
    expect((await checklist(admin)).body.complete).toBe(false);
  });

  test('a configured chat app ticks the optional item', async () => {
    const { admin } = await setUp();
    const { organizationId } = await db.orgMembership.findFirstOrThrow();
    await db.orgIntegration.create({
      data: { organizationId, provider: 'SLACK', secretEncrypted: 'sealed' },
    });
    expect(done((await checklist(admin)).body).CHAT_APP).toBe(true);
  });

  test('dismissing is remembered per Admin, on the server', async () => {
    const { admin } = await setUp();
    const otherAdmin = await join(admin, 'mint@acme.test', 'ADMIN');

    const dismissed = await call<GettingStartedView>('POST', '/me/getting-started/dismiss', admin);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.dismissed).toBe(true);
    expect((await checklist(admin)).body.dismissed).toBe(true);
    expect((await checklist(otherAdmin)).body.dismissed).toBe(false);
  });

  test('Members never get the checklist', async () => {
    const { admin } = await setUp();
    const member = await join(admin, 'beam@acme.test');
    expect((await checklist(member)).status).toBe(403);
    expect((await call('POST', '/me/getting-started/dismiss', member)).status).toBe(403);
  });

  test('every member reads the Organization language; only Admins change it', async () => {
    const { admin } = await setUp();
    const member = await join(admin, 'beam@acme.test');

    const read = await call<OrganizationSettingsView>('GET', '/settings/organization', member);
    expect(read.body).toEqual({ name: 'Acme Bank', language: 'en' });
    expect((await call('PUT', '/settings/organization', member, { language: 'th' })).status).toBe(
      403,
    );
    expect((await call('PUT', '/settings/organization', admin, { language: 'fr' })).status).toBe(
      400,
    );
    const saved = await call<OrganizationSettingsView>('PUT', '/settings/organization', admin, {
      language: 'th',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.language).toBe('th');
    expect(
      (await call<OrganizationSettingsView>('GET', '/settings/organization', member)).body,
    ).toEqual({ name: 'Acme Bank', language: 'th' });
  });
});
