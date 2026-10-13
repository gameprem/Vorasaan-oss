import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  DecisionRequestView,
  InvitationView,
  OrgMemberView,
  ProjectView,
} from '@vorasaan/shared';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Route = [Method, string, unknown?];

const { pim, beam } = SEED.users;
const FEATURE = SEED.featureId;
const PROJECT = SEED.projectId;
const TEAM = SEED.teamId;

/**
 * A record is reached by id only from inside its Organization. Someone of another
 * Organization, here even its Admin and a PO there (so "is an Admin" or "holds the PO
 * Team Role" checks alone would let them through), gets a 404 for every record of Acme,
 * the same answer as for an unknown id, and changes nothing.
 */
describe('Records are scoped to the caller’s Organization', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asOlga: ReturnType<typeof as>;
  let olgaId: string;
  const ids = {} as Record<
    | 'specVersion'
    | 'specProposal'
    | 'request'
    | 'briefProposal'
    | 'suggestion'
    | 'grilling'
    | 'attachment'
    | 'designDocProposal'
    | 'delegation'
    | 'invitation'
    | 'promptVersion',
    string
  >;

  beforeAll(async () => {
    testApp = await createTestApp();
    app = testApp.app;
    db = createTestPrisma();
    await truncateAll(db);
    await seed(db);
    asPim = as(app, pim.id);

    // Globex: another Organization, administered by Olga, who is also a PO of its Team.
    const globex = await db.organization.create({ data: { name: 'Globex' } });
    const olga = await db.user.create({
      data: { email: 'olga@globex.test', name: 'Olga', passwordHash: 'x' },
    });
    olgaId = olga.id;
    await db.orgMembership.create({
      data: { organizationId: globex.id, userId: olga.id, role: 'ADMIN' },
    });
    const globexProject = await db.project.create({
      data: { organizationId: globex.id, name: 'Globex app' },
    });
    const globexTeam = await db.team.create({
      data: { projectId: globexProject.id, name: 'Core' },
    });
    await db.teamMembership.create({
      data: { teamId: globexTeam.id, userId: olga.id, role: 'PO' },
    });
    asOlga = as(app, olga.id);

    // Acme's records, one of each kind reached by id.
    const v1 = await db.specVersion.findUniqueOrThrow({
      where: { featureId_version: { featureId: FEATURE, version: 1 } },
    });
    ids.specVersion = v1.id;
    ids.specProposal = (
      await db.specProposal.create({
        data: {
          featureId: FEATURE,
          baseVersionId: v1.id,
          source: 'CONVERSATION',
          proposedMarkdown: `${v1.markdown}\nMore.\n`,
          approverId: pim.id,
        },
      })
    ).id;
    ids.request = (
      await db.decisionRequest.create({
        data: {
          featureId: FEATURE,
          kind: 'QUESTION',
          withChoices: false,
          raiserId: beam.id,
          title: 'Which provider timeout?',
          description: 'We need a number.',
          deciderRole: 'PO',
        },
      })
    ).id;
    ids.briefProposal = (
      await db.briefProposal.create({
        data: {
          projectId: PROJECT,
          source: 'CONVERSATION',
          proposedMarkdown: '# Brief\n',
          approverId: pim.id,
        },
      })
    ).id;
    ids.suggestion = (
      await db.featureSuggestion.create({
        data: {
          projectId: PROJECT,
          batchId: crypto.randomUUID(),
          title: 'Saved cards',
          rationale: 'Faster checkout.',
          businessValue: 'More payers.',
          effort: 'LOW',
          risk: 'LOW',
          generatedById: pim.id,
        },
      })
    ).id;
    ids.grilling = (
      await db.grilling.create({ data: { projectId: PROJECT, startedById: pim.id, memory: {} } })
    ).id;
    ids.attachment = (
      await db.attachment.create({
        data: {
          featureId: FEATURE,
          source: 'URL',
          title: 'Provider docs',
          url: 'https://example.com/docs',
          addedById: pim.id,
        },
      })
    ).id;
    const designDoc = await db.designDoc.create({ data: { featureId: FEATURE, template: 'QA' } });
    ids.designDocProposal = (
      await db.designDocProposal.create({
        data: {
          designDocId: designDoc.id,
          reason: 'FIRST_DRAFT',
          specVersionId: v1.id,
          proposedMarkdown: '# QA\n',
        },
      })
    ).id;
    ids.delegation = (
      await db.delegation.create({
        data: {
          teamId: TEAM,
          role: 'PO',
          delegatorId: pim.id,
          delegateId: beam.id,
          startsAt: new Date(Date.now() + 86_400_000),
          endsAt: new Date(Date.now() + 2 * 86_400_000),
          createdById: pim.id,
        },
      })
    ).id;
    ids.invitation = (
      await db.invitation.create({
        data: {
          organizationId: SEED.organizationId,
          email: 'new@acme.test',
          tokenHash: 'not-a-real-token-hash',
          invitedById: pim.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
    ).id;
    ids.promptVersion = (
      await db.promptVersion.create({
        data: {
          organizationId: SEED.organizationId,
          promptName: 'generate-choices',
          number: 1,
          template: 'Draft Choices.',
        },
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    await testApp.designDocs.drain();
    await testApp.receipts.drain();
    await testApp.drainIndexing();
    await db.$disconnect();
    await app.close();
  });

  const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  /** Every route that reads or changes an Acme record by id, with a body that passes validation. */
  const foreignRoutes = (): Route[] => [
    // A Feature and what hangs off it.
    ['GET', `/features/${FEATURE}`],
    ['PATCH', `/features/${FEATURE}`, { jiraIssueKey: 'MB-9' }],
    ['GET', `/features/${FEATURE}/role-owners`],
    ['PUT', `/features/${FEATURE}/role-owners`, { owners: [] }],
    ['POST', `/features/${FEATURE}/spec-versions`, { markdown: '# Mine', baseVersion: 1 }],
    ['GET', `/features/${FEATURE}/spec-versions`],
    ['GET', `/features/${FEATURE}/spec-versions/1`],
    ['POST', `/features/${FEATURE}/spec-versions/1/revert`, { baseVersion: 1 }],
    ['GET', `/features/${FEATURE}/spec-diff?from=0&to=1`],
    ['GET', `/features/${FEATURE}/decision-log`],
    ['POST', `/features/${FEATURE}/spec-proposals/from-attachments`],
    [
      'POST',
      `/features/${FEATURE}/coverage/acceptance-criteria`,
      { platformId: SEED.platforms.backEnd },
    ],
    ['GET', `/features/${FEATURE}/coverage`],
    ['PUT', `/features/${FEATURE}/platforms`, { platformIds: [] }],
    ['GET', `/features/${FEATURE}/spec-template`],
    ['GET', `/features/${FEATURE}/attachments`],
    ['POST', `/features/${FEATURE}/attachments`, { url: 'https://example.com/x' }],
    ['GET', `/features/${FEATURE}/design-docs`],
    ['GET', `/features/${FEATURE}/hand-off`],
    ['GET', `/features/${FEATURE}/decision-graph`],
    // A Team.
    ['GET', `/teams/${TEAM}`],
    ['PUT', `/teams/${TEAM}/members/${olgaId}`, { roles: ['PO'] }],
    ['POST', `/teams/${TEAM}/features`, { title: 'Planted' }],
    ['GET', `/teams/${TEAM}/delegations`],
    [
      'POST',
      `/teams/${TEAM}/delegations`,
      { delegateId: olgaId, role: 'PO', startsAt: later(1), endsAt: later(2) },
    ],
    ['DELETE', `/teams/${TEAM}/delegations/${ids.delegation}`],
    // A Project.
    ['POST', `/projects/${PROJECT}/teams`, { name: 'Planted' }],
    ['GET', `/projects/${PROJECT}/brief`],
    ['GET', `/projects/${PROJECT}/brief-versions`],
    ['GET', `/projects/${PROJECT}/brief-proposals`],
    ['GET', `/projects/${PROJECT}/coverage`],
    ['GET', `/projects/${PROJECT}/decision-stats`],
    ['GET', `/projects/${PROJECT}/platforms`],
    ['GET', `/projects/${PROJECT}/feature-guidelines/effective`],
    ['GET', `/projects/${PROJECT}/grillings`],
    ['GET', `/projects/${PROJECT}/attachments`],
    ['POST', `/projects/${PROJECT}/repo-scans`, { markdown: '# Repo', repoName: 'acme/app' }],
    ['GET', `/projects/${PROJECT}/feature-suggestions`],
    ['GET', `/projects/${PROJECT}/design-templates`],
    ['GET', `/projects/${PROJECT}/response-windows`],
    // A Spec Proposal.
    ['GET', `/spec-proposals/${ids.specProposal}`],
    ['POST', `/spec-proposals/${ids.specProposal}/approve`, {}],
    ['POST', `/spec-proposals/${ids.specProposal}/reject`, {}],
    ['GET', `/spec-proposals/${ids.specProposal}/redrafts`],
    ['POST', `/spec-proposals/${ids.specProposal}/request-changes`, { feedback: 'Shorter' }],
    // A Decision Request.
    ['GET', `/decision-requests/${ids.request}`],
    ['POST', `/decision-requests/${ids.request}/submit`, { deciderRole: 'PO' }],
    ['POST', `/decision-requests/${ids.request}/claim`],
    ['POST', `/decision-requests/${ids.request}/reassign`, { userId: olgaId }],
    ['POST', `/decision-requests/${ids.request}/messages`, { kind: 'NOTE', body: 'Hi' }],
    ['POST', `/decision-requests/${ids.request}/decision`, { customAnswer: '5 seconds' }],
    ['POST', `/decision-requests/${ids.request}/withdraw`],
    ['GET', `/decision-requests/${ids.request}/choices/redrafts`],
    ['POST', `/decision-requests/${ids.request}/choices/request-changes`, { feedback: 'More' }],
    [
      'POST',
      '/decision-requests',
      { featureId: FEATURE, kind: 'QUESTION', title: 'Mine?', description: 'x' },
    ],
    // A Brief Proposal, a Feature Suggestion, a Grilling.
    ['GET', `/brief-proposals/${ids.briefProposal}`],
    ['POST', `/brief-proposals/${ids.briefProposal}/approve`, {}],
    ['POST', `/brief-proposals/${ids.briefProposal}/reject`, {}],
    ['GET', `/brief-proposals/${ids.briefProposal}/redrafts`],
    ['POST', `/feature-suggestions/${ids.suggestion}/accept`, { teamId: TEAM }],
    ['POST', `/feature-suggestions/${ids.suggestion}/dismiss`, { reason: 'No' }],
    ['GET', `/feature-suggestions/${ids.suggestion}/redrafts`],
    ['GET', `/grillings/${ids.grilling}`],
    ['POST', `/grillings/${ids.grilling}/cancel`],
    ['POST', `/grillings/${ids.grilling}/skip-round`, { round: 'BUSINESS' }],
    ['POST', `/grillings/${ids.grilling}/conversation`],
    // An Attachment.
    ['GET', `/attachments/${ids.attachment}/file`],
    ['POST', `/attachments/${ids.attachment}/refresh`],
    ['DELETE', `/attachments/${ids.attachment}`],
    // A Design Doc proposal.
    ['GET', `/design-doc-proposals/${ids.designDocProposal}`],
    ['POST', `/design-doc-proposals/${ids.designDocProposal}/approve`, {}],
    ['POST', `/design-doc-proposals/${ids.designDocProposal}/decline`, {}],
    ['GET', `/design-doc-proposals/${ids.designDocProposal}/redrafts`],
    // Admin routes: Olga administers Globex, not Acme.
    ['DELETE', `/invitations/${ids.invitation}`],
    ['GET', `/prompt-versions/${ids.promptVersion}/redrafts`],
  ];

  test('every route answers 404 to someone of another Organization, as for an unknown id', async () => {
    const answered: string[] = [];
    for (const [method, url, body] of foreignRoutes()) {
      const res = await asOlga(method, url, body);
      answered.push(`${res.status} ${method} ${url}`);
    }
    expect(answered).toEqual(foreignRoutes().map(([method, url]) => `404 ${method} ${url}`));

    // A 404 for a foreign record says what an unknown id says.
    const foreign = await asOlga<{ message: string }>('GET', `/features/${FEATURE}`);
    const unknown = await asOlga<{ message: string }>('GET', `/features/${crypto.randomUUID()}`);
    expect(foreign.body).toEqual(unknown.body);
    const foreignProposal = await asOlga('GET', `/brief-proposals/${ids.briefProposal}`);
    const unknownProposal = await asOlga('GET', `/brief-proposals/${crypto.randomUUID()}`);
    expect(foreignProposal.body).toEqual(unknownProposal.body);
  });

  test('nothing of Acme changed', async () => {
    const [feature, versions, owners, request, proposal, attachments, teams, delegations] =
      await Promise.all([
        db.feature.findUniqueOrThrow({ where: { id: FEATURE } }),
        db.specVersion.count({ where: { featureId: FEATURE } }),
        db.roleOwner.count({ where: { featureId: FEATURE } }),
        db.decisionRequest.findUniqueOrThrow({ where: { id: ids.request } }),
        db.specProposal.findUniqueOrThrow({ where: { id: ids.specProposal } }),
        db.attachment.count({ where: { OR: [{ featureId: FEATURE }, { projectId: PROJECT }] } }),
        db.team.count({ where: { projectId: PROJECT } }),
        db.delegation.count({ where: { teamId: TEAM } }),
      ]);
    expect(feature.jiraIssueKey).toBeNull();
    expect(versions).toBe(1);
    expect(owners).toBe(2);
    expect(request.status).toBe('DRAFT');
    expect(await db.decisionRequest.count({ where: { featureId: FEATURE } })).toBe(1);
    expect(proposal.status).toBe('PENDING');
    expect(attachments).toBe(1);
    expect(teams).toBe(1);
    expect(delegations).toBe(1);
    expect(await db.feature.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await db.teamMembership.count({ where: { userId: olgaId, teamId: TEAM } })).toBe(0);
    expect(await db.invitation.count({ where: { id: ids.invitation } })).toBe(1);
    expect(await db.briefProposal.count({ where: { status: 'PENDING' } })).toBe(1);
    expect(await db.featureSuggestion.count({ where: { status: 'PENDING' } })).toBe(1);
    expect(await db.grilling.count({ where: { status: 'RUNNING' } })).toBe(1);
    expect(await db.designDocProposal.count({ where: { status: 'PENDING' } })).toBe(1);
  });

  test('lists hold only the caller’s Organization', async () => {
    const projects = await asOlga<ProjectView[]>('GET', '/projects');
    expect(projects.body.map((p) => p.name)).toEqual(['Globex app']);
    const members = await asOlga<OrgMemberView[]>('GET', '/members');
    expect(members.body.map((m) => m.name)).toEqual(['Olga']);
    expect((await asOlga<InvitationView[]>('GET', '/invitations')).body).toEqual([]);
    expect((await asOlga<DecisionRequestView[]>('GET', '/decision-requests')).body).toEqual([]);

    expect((await asPim<ProjectView[]>('GET', '/projects')).body.map((p) => p.id)).toEqual([
      PROJECT,
    ]);
    const acme = (await asPim<OrgMemberView[]>('GET', '/members')).body.map((m) => m.name);
    expect(acme.sort()).toEqual(['Beam', 'Pim']);
    expect((await asPim<InvitationView[]>('GET', '/invitations')).body.map((i) => i.id)).toEqual([
      ids.invitation,
    ]);
    expect(
      (await asPim<DecisionRequestView[]>('GET', '/decision-requests')).body.map((r) => r.id),
    ).toEqual([ids.request]);
  });

  test('inside the Organization the same records still read', async () => {
    const reads = [
      `/features/${FEATURE}`,
      `/features/${FEATURE}/role-owners`,
      `/features/${FEATURE}/spec-versions`,
      `/features/${FEATURE}/spec-versions/1`,
      `/features/${FEATURE}/spec-diff?from=0&to=1`,
      `/features/${FEATURE}/decision-log`,
      `/features/${FEATURE}/coverage`,
      `/features/${FEATURE}/spec-template`,
      `/features/${FEATURE}/attachments`,
      `/teams/${TEAM}`,
      `/teams/${TEAM}/delegations`,
      `/projects/${PROJECT}/brief`,
      `/projects/${PROJECT}/coverage`,
      `/projects/${PROJECT}/attachments`,
      `/spec-proposals/${ids.specProposal}`,
      `/spec-proposals/${ids.specProposal}/redrafts`,
      `/decision-requests/${ids.request}`,
      `/decision-requests/${ids.request}/choices/redrafts`,
      `/brief-proposals/${ids.briefProposal}`,
      `/brief-proposals/${ids.briefProposal}/redrafts`,
      `/feature-suggestions/${ids.suggestion}/redrafts`,
      `/design-doc-proposals/${ids.designDocProposal}`,
      `/design-doc-proposals/${ids.designDocProposal}/redrafts`,
      `/prompt-versions/${ids.promptVersion}/redrafts`,
    ];
    const answered: string[] = [];
    for (const url of reads) answered.push(`${(await asPim('GET', url)).status} ${url}`);
    expect(answered).toEqual(reads.map((url) => `200 ${url}`));

    // And a change inside the Organization still goes through.
    const patched = await asPim('PATCH', `/features/${FEATURE}`, { jiraIssueKey: 'MB-1' });
    expect(patched.status).toBe(200);
    const role = await asPim('PUT', `/teams/${TEAM}/members/${beam.id}`, {
      roles: ['BACKEND', 'QA'],
    });
    expect(role.status).toBe(200);
  });

  test('a Team takes only people of its own Organization', async () => {
    // Pim administers Acme: Olga, of Globex, can't be given a Team Role in Acme's Team.
    const res = await asPim('PUT', `/teams/${TEAM}/members/${olgaId}`, { roles: ['PO'] });
    expect(res.status).toBe(404);
    expect(await db.teamMembership.count({ where: { userId: olgaId, teamId: TEAM } })).toBe(0);
  });
});
