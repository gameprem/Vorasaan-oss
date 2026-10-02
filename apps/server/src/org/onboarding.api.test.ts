import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import type {
  CreatedInvitation,
  DecideResult,
  DecisionRequestView,
  InvitationPreview,
  LoginResult,
  ProjectView,
  RoleOwnerView,
  SpecVersionView,
  TeamView,
} from '@vorasaan/shared';
import { SETUP_TOKEN_HEADER } from '@vorasaan/shared';
import { SetupTokenService } from '../setup/setup-token.service.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';

describe('Onboarding from an empty install', () => {
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

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(() => truncateAll(db));

  /** Setup as Nok (Admin), then invite and accept Beam (Backend). */
  async function world() {
    // A fresh install, with the Setup Token from the server log.
    const setupToken = app.get(SetupTokenService).arm() as string;
    const setupRes = await app.inject({
      method: 'POST',
      url: '/setup',
      headers: { [SETUP_TOKEN_HEADER]: setupToken },
      payload: {
        organizationName: 'Acme Bank',
        admin: { name: 'Nok', email: 'nok@acme.test', password: 'long-enough-pass' },
        ai: { provider: 'ANTHROPIC', model: 'claude-opus-5-5', apiKey: 'sk-ant-x' },
      },
    });
    const setup = { body: setupRes.json() as LoginResult };
    const admin = setup.body.token;

    const project = await call<{ id: string }>('POST', '/projects', admin, {
      name: 'Mobile Banking',
      jiraKey: 'mb',
    });
    const team = await call<{ id: string }>('POST', `/projects/${project.body.id}/teams`, admin, {
      name: 'Checkout',
    });

    const invite = await call<CreatedInvitation>('POST', '/invitations', admin, {
      email: 'Beam@acme.test',
    });
    const preview = await call<InvitationPreview>('GET', `/invite/${invite.body.token}`);
    const accepted = await call<LoginResult>('POST', `/invite/${invite.body.token}`, undefined, {
      name: 'Beam',
      password: 'beam-password-1',
    });
    return {
      admin,
      adminId: setup.body.user.id,
      dev: accepted.body.token,
      devId: accepted.body.user.id,
      projectId: project.body.id,
      teamId: team.body.id,
      invite,
      preview,
    };
  }

  test('setup → invite → Feature with Spec v1 → dev raises → PO decides', async () => {
    const w = await world();
    expect(w.preview.body).toEqual({ organizationName: 'Acme Bank', email: 'beam@acme.test' });

    const projects = await call<ProjectView[]>('GET', '/projects', w.dev);
    expect(projects.body[0]).toMatchObject({ name: 'Mobile Banking', jiraKey: 'MB' });

    await call('PUT', `/teams/${w.teamId}/members/${w.adminId}`, w.admin, { roles: ['PO'] });
    const team = await call<TeamView>('PUT', `/teams/${w.teamId}/members/${w.devId}`, w.admin, {
      roles: ['BACKEND'],
    });
    expect(team.body.members.map((m) => [m.name, m.roles])).toEqual([
      ['Nok', ['PO']],
      ['Beam', ['BACKEND']],
    ]);

    const feature = await call<{ id: string }>('POST', `/teams/${w.teamId}/features`, w.admin, {
      title: 'Async checkout',
      jiraIssueKey: 'mb-42',
    });
    const owners = await call<RoleOwnerView[]>(
      'PUT',
      `/features/${feature.body.id}/role-owners`,
      w.admin,
      {
        owners: [
          { userId: w.adminId, role: 'PO' },
          { userId: w.devId, role: 'BACKEND' },
        ],
      },
    );
    expect(owners.body.map((o) => o.role)).toEqual(['PO', 'BACKEND']);

    const spec = await call<SpecVersionView>(
      'POST',
      `/features/${feature.body.id}/spec-versions`,
      w.admin,
      { markdown: '# Async checkout\n\nPay without waiting.', baseVersion: 0 },
    );
    expect(spec.body).toMatchObject({ version: 1, source: 'MANUAL', summary: 'Initial Spec' });

    const draft = await call<DecisionRequestView>('POST', '/decision-requests', w.dev, {
      featureId: feature.body.id,
      kind: 'BLOCKER',
      title: 'No webhook',
      description: 'Polling only',
    });
    const open = await call<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.body.id}/submit`,
      w.dev,
      { deciderRole: 'PO' },
    );
    expect(open.body.decider?.name).toBe('Nok');

    const decided = await call<DecideResult>(
      'POST',
      `/decision-requests/${draft.body.id}/decision`,
      w.admin,
      { choiceId: open.body.choices[0]?.id },
    );
    expect(decided.status).toBe(201);
  });

  test('members cannot create Projects or Teams, invite, or manage a Team', async () => {
    const w = await world();
    expect((await call('POST', '/projects', w.dev, { name: 'X' })).status).toBe(403);
    expect(
      (await call('POST', `/projects/${w.projectId}/teams`, w.dev, { name: 'Y' })).status,
    ).toBe(403);
    expect((await call('POST', '/invitations', w.dev, { email: 'z@acme.test' })).status).toBe(403);
    expect(
      (await call('PUT', `/teams/${w.teamId}/members/${w.devId}`, w.dev, { roles: ['PO'] })).status,
    ).toBe(403);
    expect(
      (await call('POST', `/teams/${w.teamId}/features`, w.dev, { title: 'Sneaky' })).status,
    ).toBe(403);
  });

  test("a Team's PO can manage that Team without being an Admin", async () => {
    const w = await world();
    await call('PUT', `/teams/${w.teamId}/members/${w.devId}`, w.admin, { roles: ['PO'] });
    const res = await call('POST', `/teams/${w.teamId}/features`, w.dev, { title: 'Refunds' });
    expect(res.status).toBe(201);
  });

  test('invite links work once, and not for existing members', async () => {
    const w = await world();
    expect(
      (
        await call('POST', `/invite/${w.invite.body.token}`, undefined, {
          name: 'Again',
          password: 'beam-password-1',
        })
      ).status,
    ).toBe(410);
    expect((await call('GET', '/invite/vsi_nope')).status).toBe(404);
    expect((await call('POST', '/invitations', w.admin, { email: 'beam@acme.test' })).status).toBe(
      409,
    );
  });

  test('Role Owners must hold the Team Role; the Spec is guarded against stale saves', async () => {
    const w = await world();
    const feature = await call<{ id: string }>('POST', `/teams/${w.teamId}/features`, w.admin, {
      title: 'F',
    });
    const res = await call('PUT', `/features/${feature.body.id}/role-owners`, w.admin, {
      owners: [{ userId: w.devId, role: 'BACKEND' }],
    });
    expect(res.status).toBe(422);

    const url = `/features/${feature.body.id}/spec-versions`;
    expect((await call('POST', url, w.admin, { markdown: '# v1', baseVersion: 0 })).status).toBe(
      201,
    );
    expect((await call('POST', url, w.admin, { markdown: '# stale', baseVersion: 0 })).status).toBe(
      409,
    );
    expect((await call('POST', url, w.dev, { markdown: '# v2', baseVersion: 1 })).status).toBe(403);
  });
});
