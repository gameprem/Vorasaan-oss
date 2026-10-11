import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  DecisionGraphView,
  DecisionRequestView,
  DesignDocDetailView,
  DesignDocProposalView,
  DesignDocSummary,
  DesignDocVersionView,
  DesignTemplatesView,
  FeatureDesignDocsView,
  InboxItem,
  ProjectPlatformsView,
  ProposalRedraftsView,
  RequestChangesResult,
  SpecDiff,
  SpecVersionView,
} from '@vorasaan/shared';
import type { AiPort } from '../ai/ai.port.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;
const FEATURE = SEED.featureId;
const PROJECT = SEED.projectId;
const BACK_END = SEED.platforms.backEnd;
const FRONT_END = SEED.platforms.frontEnd;

/** Back-End and Front-End sections, each with acceptance criteria; two open questions. */
const SPEC = `# Async checkout

## Goal
Let customers leave checkout before the provider confirms.

## Acceptance criteria
- [ ] Tapping Pay returns to the order screen in under 1 second.

## Back-End
POST /payments answers 202 and polls PayFast every 5 seconds.

### Acceptance criteria
- [ ] A payment is never confirmed twice.

## Front-End
The order card shows Processing until the provider answers.

### Acceptance criteria
- [ ] Retry is one tap from the order card.

## Out of scope
- Refunds.

## Open questions
- How long do we wait for the provider before failing a payment?
`;

/** The same Spec with only the Back-End section changed. */
const SPEC_BACK_END_CHANGED = SPEC.replace('every 5 seconds', 'every 10 seconds');
/** Only the Back-End section: Front-End has no section, so its Coverage is missing. */
const SPEC_NO_FRONT_END = SPEC.replace(/## Front-End[\s\S]*?(?=## Out of scope)/, '');

describe('Design Docs per Platform (ticket 0069)', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;

  const settle = async () => {
    await testApp.designDocs.drain();
    await testApp.receipts.drain();
  };

  async function writeSpec(markdown: string): Promise<SpecVersionView> {
    const versions = await asPim<SpecVersionView[]>('GET', `/features/${FEATURE}/spec-versions`);
    const res = await asPim<SpecVersionView>('POST', `/features/${FEATURE}/spec-versions`, {
      markdown,
      baseVersion: versions.body[0]?.version ?? 0,
    });
    expect(res.status).toBe(201);
    await settle();
    return res.body;
  }

  async function setRoles(userId: string, roles: TeamRole[]) {
    const res = await asPim('PUT', `/teams/${SEED.teamId}/members/${userId}`, { roles });
    expect(res.status).toBe(200);
  }

  async function docs(as = asPim): Promise<FeatureDesignDocsView> {
    const res = await as<FeatureDesignDocsView>('GET', `/features/${FEATURE}/design-docs`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function doc(key: string, as = asPim): Promise<DesignDocSummary> {
    const found = (await docs(as)).docs.find((d) => d.key === key);
    if (!found) throw new Error(`no Design Doc ${key}`);
    return found;
  }

  async function detail(key: string, as = asPim): Promise<DesignDocDetailView> {
    const res = await as<DesignDocDetailView>('GET', `/features/${FEATURE}/design-docs/${key}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function approve(proposalId: string, as = asBeam, body?: unknown) {
    return as<DesignDocVersionView>('POST', `/design-doc-proposals/${proposalId}/approve`, body);
  }

  const drafts = () =>
    ai.calls
      .filter((c) => c.method === 'draftDesignDoc')
      .map((c) => c.input as Parameters<AiPort['draftDesignDoc']>[0]);

  beforeAll(async () => {
    testApp = await createTestApp();
    ({ app, ai } = testApp);
    db = createTestPrisma();
    asPim = as(app, pim.id);
    asBeam = as(app, beam.id);
  });

  afterAll(async () => {
    await settle();
    await testApp.drainIndexing();
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await settle();
    await testApp.drainIndexing();
    await truncateAll(db);
    await seed(db);
    ai.calls.length = 0;
    ai.designDocScript.length = 0;
    // Pim holds PO, QA and FRONTEND (no Role Owner of either: she answers for them as a
    // Team member); Beam holds BACKEND and owns it on the Feature. Nobody is a Tech Lead.
    await setRoles(pim.id, ['PO', 'QA', 'FRONTEND']);
    const targeted = await asPim('PUT', `/features/${FEATURE}/platforms`, {
      platformIds: [BACK_END, FRONT_END],
    });
    expect(targeted.status).toBe(200);
    await settle();
    ai.calls.length = 0;
  });

  test('no draft while a Spec Proposal awaits approval or Coverage is missing; a draft once both hold', async () => {
    // The seeded Spec has no Platform sections: nothing is covered, nothing is drafted.
    let list = await docs();
    expect(list.docs.map((d) => [d.name, d.state])).toEqual([
      ['Back-End', 'WAITING'],
      ['Front-End', 'WAITING'],
      ['QA', 'WAITING'],
    ]);
    expect(list.docs[0]?.waiting).toEqual([{ kind: 'COVERAGE_MISSING' }]);
    expect(list.docs[2]?.waiting).toEqual([
      {
        kind: 'PLATFORMS_NOT_COVERED',
        platforms: [
          { id: BACK_END, name: 'Back-End' },
          { id: FRONT_END, name: 'Front-End' },
        ],
      },
    ]);

    // Back-End is covered once the Spec has its section; Front-End still has none. A Spec
    // Proposal awaits approval on that version (written here directly, so that nothing has
    // been drafted before it): still no draft, even when asked for.
    const v2 = await db.specVersion.create({
      data: {
        featureId: FEATURE,
        version: 2,
        markdown: SPEC_NO_FRONT_END,
        source: 'MANUAL',
        approvedById: pim.id,
      },
    });
    const pending = await db.specProposal.create({
      data: {
        featureId: FEATURE,
        baseVersionId: v2.id,
        source: 'CONVERSATION',
        proposedMarkdown: SPEC,
        approverId: pim.id,
      },
    });
    await testApp.designDocs.sync(FEATURE);
    await settle();
    expect(drafts()).toHaveLength(0);
    const waiting = await doc(BACK_END);
    expect(waiting.state).toBe('WAITING');
    expect(waiting.waiting).toEqual([{ kind: 'SPEC_PROPOSAL_PENDING', proposalId: pending.id }]);
    const asked = await asBeam('POST', `/features/${FEATURE}/design-docs/${BACK_END}/draft`);
    expect(asked.status).toBe(422);
    expect(drafts()).toHaveLength(0);

    // Declining the Spec Proposal settles the Spec: Back-End is drafted, nothing else.
    const rejected = await asPim('POST', `/spec-proposals/${pending.id}/reject`, {});
    expect(rejected.status).toBe(201);
    await settle();
    expect(drafts().map((d) => d.doc.name)).toEqual(['Back-End']);
    list = await docs();
    expect(list.docs.map((d) => [d.name, d.state])).toEqual([
      ['Back-End', 'PROPOSED'],
      ['Front-End', 'WAITING'],
      ['QA', 'WAITING'],
    ]);
    const input = drafts()[0];
    expect(input?.specVersion).toBe(2);
    expect(input?.current).toBeNull();
    expect(input?.doc.platform).toEqual({ name: 'Back-End', roles: ['BACKEND'] });
    expect(input?.doc.template).toContain('## API contract');

    // With the Front-End section, Front-End and then QA (every target covered) are drafted.
    ai.calls.length = 0;
    await writeSpec(SPEC);
    expect(
      drafts()
        .map((d) => d.doc.name)
        .sort(),
    ).toEqual(['Front-End', 'QA']);
    list = await docs();
    expect(list.docs.map((d) => d.state)).toEqual(['PROPOSED', 'PROPOSED', 'PROPOSED']);
    // The Back-End draft covers the same in v3 as in v2: it now follows v3, not superseded.
    expect(list.docs[0]?.proposal?.specVersion).toBe(3);
    // QA reads the whole Spec; a Platform's leaves out the other Platforms' sections.
    const qa = drafts().find((d) => d.doc.name === 'QA');
    const frontEnd = drafts().find((d) => d.doc.name === 'Front-End');
    expect(qa?.specMarkdown).toContain('## Back-End');
    expect(qa?.doc.template).toContain('## Test cases');
    expect(frontEnd?.specMarkdown).not.toContain('## Back-End');
    expect(frontEnd?.specMarkdown).toContain('## Front-End');
    expect(frontEnd?.doc.template).toContain('## Screens and states');
  });

  test('approve creates version 1; Request changes produces a Redraft; a later approved change shows a diff', async () => {
    await writeSpec(SPEC);
    const proposed = await doc(BACK_END);
    expect(proposed.state).toBe('PROPOSED');
    const proposalId = proposed.proposal?.id ?? '';

    const view = await asBeam<DesignDocProposalView>('GET', `/design-doc-proposals/${proposalId}`);
    expect(view.status).toBe(200);
    expect(view.body.canReview).toBe(true);
    expect(view.body.reason).toBe('FIRST_DRAFT');
    expect(view.body.baseMarkdown).toBe('');
    expect(view.body.proposedMarkdown).toContain('## API contract');

    const v1 = await approve(proposalId);
    expect(v1.status).toBe(201);
    expect(v1.body.version).toBe(1);
    expect(v1.body.specVersion).toBe(2);
    expect(v1.body.approvedBy).toEqual({ id: beam.id, name: 'Beam' });
    const approved = await doc(BACK_END);
    expect(approved.state).toBe('APPROVED');
    expect(approved.current?.version).toBe(1);
    expect(approved.proposal).toBeNull();
    // Approved twice is a 409.
    expect((await approve(proposalId)).status).toBe(409);

    // The Spec changes the Back-End section: the AI proposes an update, Beam asks for changes.
    await writeSpec(SPEC_BACK_END_CHANGED);
    const stale = await doc(BACK_END);
    expect(stale.state).toBe('STALE');
    expect(stale.proposal?.reason).toBe('SPEC_CHANGED');
    const update = stale.proposal?.id ?? '';
    const asked = await asBeam<RequestChangesResult>(
      'POST',
      `/design-doc-proposals/${update}/request-changes`,
      { feedback: 'Name the polling worker', pointer: { kind: 'SECTION', heading: 'Sequences' } },
    );
    expect(asked.status).toBe(201);
    expect(asked.body.redraft.number).toBe(2);
    expect(asked.body.redraft.text).toContain('- Changed as asked: Name the polling worker');
    const redraftInput = ai.calls.find((c) => c.method === 'redraftDesignDoc')?.input as Parameters<
      AiPort['redraftDesignDoc']
    >[0];
    expect(redraftInput.feedback.pointer).toContain('Sequences');
    expect(redraftInput.specVersion).toBe(3);
    expect(redraftInput.doc.name).toBe('Back-End');
    const redrafts = await asBeam<ProposalRedraftsView>(
      'GET',
      `/design-doc-proposals/${update}/redrafts`,
    );
    expect(redrafts.body.current).toBe(2);
    expect(redrafts.body.redrafts.map((r) => r.number)).toEqual([1, 2]);

    // Approving Redraft 1 when 2 is current changes nothing; approving 2 is version 2.
    expect((await approve(update, asBeam, { redraft: 1 })).status).toBe(409);
    const v2 = await approve(update, asBeam, { redraft: 2 });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    expect(v2.body.specVersion).toBe(3);
    expect((await doc(BACK_END)).state).toBe('APPROVED');

    const diff = await asPim<SpecDiff>(
      'GET',
      `/features/${FEATURE}/design-docs/${BACK_END}/diff?from=1&to=2`,
    );
    expect(diff.status).toBe(200);
    const added = diff.body.lines.filter((l) => l.kind === 'ADDED').map((l) => l.text);
    expect(added).toContain('- Changed as asked: Name the polling worker');
    expect(added.some((l) => l.startsWith('- Updated for Spec v3'))).toBe(true);
    expect(diff.body.removed).toBe(0);

    const history = await detail(BACK_END);
    expect(history.versions.map((v) => [v.version, v.specVersion, v.source])).toEqual([
      [2, 3, 'AI_DRAFT'],
      [1, 2, 'AI_DRAFT'],
    ]);
  });

  test('a new Spec Version that changes the Back-End section makes only the Back-End Design Doc stale, and the AI proposes an update', async () => {
    await writeSpec(SPEC);
    for (const key of [BACK_END, FRONT_END]) {
      const by = key === BACK_END ? asBeam : asPim;
      const id = (await doc(key)).proposal?.id ?? '';
      expect((await approve(id, by)).status).toBe(201);
    }
    ai.calls.length = 0;

    await writeSpec(SPEC_BACK_END_CHANGED);
    const list = await docs();
    const [backEnd, frontEnd, qa] = list.docs;
    expect(backEnd?.state).toBe('STALE');
    expect(backEnd?.current?.specVersion).toBe(2);
    expect(backEnd?.proposal).toMatchObject({ reason: 'SPEC_CHANGED', specVersion: 3 });
    expect(frontEnd?.state).toBe('APPROVED');
    expect(frontEnd?.proposal).toBeNull();
    // QA's first draft (pending since v2) covers the whole Spec: superseded, drafted again.
    expect(qa?.state).toBe('PROPOSED');
    expect(qa?.proposal?.specVersion).toBe(3);
    expect(await db.designDocProposal.count({ where: { status: 'SUPERSEDED' } })).toBe(1);

    // The update starts from the approved Design Doc and is told what changed.
    const update = drafts().find((d) => d.doc.name === 'Back-End');
    expect(update?.current).toContain('## API contract');
    expect(update?.specChange).toContain(
      '+ POST /payments answers 202 and polls PayFast every 10 seconds.',
    );
    expect(update?.specChange).toContain(
      '- POST /payments answers 202 and polls PayFast every 5 seconds.',
    );
    expect(
      drafts()
        .map((d) => d.doc.name)
        .sort(),
    ).toEqual(['Back-End', 'QA']);

    // A Front-End change leaves Back-End's pending update alone (it doesn't cover it).
    ai.calls.length = 0;
    await writeSpec(SPEC_BACK_END_CHANGED.replace('shows Processing', 'shows Paying'));
    const after = await docs();
    expect(after.docs[0]?.proposal?.id).toBe(backEnd?.proposal?.id ?? '');
    expect(after.docs[0]?.proposal?.specVersion).toBe(4);
    expect(after.docs[1]?.state).toBe('STALE');
    expect(
      drafts()
        .map((d) => d.doc.name)
        .sort(),
    ).toEqual(['Front-End', 'QA']);
    // The Spec never changes because of a Design Doc.
    expect(await db.specVersion.count({ where: { featureId: FEATURE } })).toBe(4);
  });

  test("only the Platform's Tech Lead or Role Owners approve; others get a 403 and nothing changes", async () => {
    await writeSpec(SPEC);
    const backEnd = (await doc(BACK_END)).proposal?.id ?? '';
    const frontEnd = (await doc(FRONT_END)).proposal?.id ?? '';
    expect((await doc(BACK_END, asPim)).canApprove).toBe(false);
    expect((await doc(BACK_END, asBeam)).canApprove).toBe(true);
    expect((await doc(BACK_END)).approverRoles).toEqual(['TECH_LEAD', 'BACKEND']);

    // Pim is an Admin and the PO, but not a Back-End Role Owner nor a Tech Lead.
    const refused = [
      await approve(backEnd, asPim),
      await asPim('POST', `/design-doc-proposals/${backEnd}/decline`, { reason: 'No' }),
      await asPim('POST', `/design-doc-proposals/${backEnd}/request-changes`, {
        feedback: 'Shorter',
      }),
      // Beam doesn't hold FRONTEND.
      await approve(frontEnd, asBeam),
    ];
    expect(refused.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(await db.designDocVersion.count()).toBe(0);
    expect(await db.redraft.count()).toBe(0);
    expect(ai.calls.some((c) => c.method === 'redraftDesignDoc')).toBe(false);
    expect(await db.designDocProposal.count({ where: { status: 'PENDING' } })).toBe(3);

    // A Tech Lead approves any Platform's; the Team-member fallback stops once the Feature
    // has a Role Owner of that role.
    await setRoles(pim.id, ['PO', 'QA', 'FRONTEND', 'TECH_LEAD']);
    expect((await approve(backEnd, asPim)).status).toBe(201);
    await setRoles(beam.id, ['BACKEND', 'FRONTEND']);
    await asPim('PUT', `/features/${FEATURE}/role-owners`, {
      owners: [
        { userId: pim.id, role: 'PO' },
        { userId: beam.id, role: 'BACKEND' },
        { userId: beam.id, role: 'FRONTEND' },
      ],
    });
    await setRoles(pim.id, ['PO', 'QA', 'FRONTEND']);
    expect((await doc(FRONT_END, asPim)).canApprove).toBe(false);
    expect((await approve(frontEnd, asPim)).status).toBe(403);
    expect((await approve(frontEnd, asBeam)).status).toBe(201);

    // Reverting and asking for a draft are the approvers' too.
    const revert = await asPim(
      'POST',
      `/features/${FEATURE}/design-docs/${BACK_END}/versions/1/revert`,
      {
        baseVersion: 1,
      },
    );
    expect(revert.status).toBe(403);
    const ask = await asPim('POST', `/features/${FEATURE}/design-docs/${BACK_END}/draft`);
    expect(ask.status).toBe(403);
  });

  test('a question the AI finds while drafting becomes a Decision Request, raised once', async () => {
    await writeSpec(SPEC);
    const requests = await db.decisionRequest.findMany({
      where: { featureId: FEATURE },
      orderBy: { createdAt: 'asc' },
    });
    // Back-End's, Front-End's and QA's drafts each found the Spec's open question.
    const backEndDoc = await db.designDoc.findFirstOrThrow({ where: { platformId: BACK_END } });
    const fromBackEnd = requests.filter((r) => r.designDocId === backEndDoc.id);
    expect(fromBackEnd).toHaveLength(1);
    expect(fromBackEnd[0]).toMatchObject({
      kind: 'QUESTION',
      status: 'DRAFT',
      withChoices: false,
      raiserId: beam.id,
      deciderRole: 'PO',
      title: 'How long do we wait for the provider before failing a payment?',
    });
    expect(fromBackEnd[0]?.description).toContain(
      'Found while drafting the Back-End Design Doc from Spec v2.',
    );
    // Front-End and QA have no Role Owner to raise it (Pim answers for them as a Team member).
    expect(requests).toHaveLength(1);
    expect((await doc(BACK_END)).questions).toEqual([
      {
        id: fromBackEnd[0]?.id ?? '',
        title: 'How long do we wait for the provider before failing a payment?',
        status: 'DRAFT',
        raiser: { id: beam.id, name: 'Beam' },
      },
    ]);

    // The Raiser sends it like any Question.
    const sent = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${fromBackEnd[0]?.id}/submit`,
      { deciderRole: 'PO' },
    );
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('OPEN');

    // The next draft is told it was asked, and doesn't raise it again.
    const id = (await doc(BACK_END)).proposal?.id ?? '';
    await approve(id);
    ai.calls.length = 0;
    await writeSpec(SPEC_BACK_END_CHANGED);
    expect(drafts().find((d) => d.doc.name === 'Back-End')?.asked).toEqual([
      'How long do we wait for the provider before failing a payment?',
    ]);
    expect(await db.decisionRequest.count({ where: { designDocId: backEndDoc.id } })).toBe(1);
  });

  test('a failed draft says why and can be asked for again; a declined one waits for a person', async () => {
    ai.designDocScript.push(new Error('provider down'));
    await writeSpec(SPEC_NO_FRONT_END);
    const failed = await doc(BACK_END);
    expect(failed.state).toBe('READY');
    expect(failed.draftError).toContain('provider down');

    const asked = await asBeam<DesignDocSummary>(
      'POST',
      `/features/${FEATURE}/design-docs/${BACK_END}/draft`,
    );
    expect(asked.status).toBe(201);
    await settle();
    const proposed = await doc(BACK_END);
    expect(proposed.state).toBe('PROPOSED');
    expect(proposed.draftError).toBeNull();
    // Asked again while one waits for approval: 409.
    expect(
      (await asBeam('POST', `/features/${FEATURE}/design-docs/${BACK_END}/draft`)).status,
    ).toBe(409);

    // Declined: not drafted again for the same Spec Version on its own.
    const declined = await asBeam<DesignDocProposalView>(
      'POST',
      `/design-doc-proposals/${proposed.proposal?.id}/decline`,
      { reason: 'Use a queue, not polling' },
    );
    expect(declined.status).toBe(201);
    expect(declined.body).toMatchObject({
      status: 'DECLINED',
      declineReason: 'Use a queue, not polling',
    });
    ai.calls.length = 0;
    await testApp.designDocs.sync(FEATURE);
    await settle();
    expect(drafts()).toHaveLength(0);
    expect((await doc(BACK_END)).state).toBe('READY');
    expect(
      (await asBeam('POST', `/features/${FEATURE}/design-docs/${BACK_END}/draft`)).status,
    ).toBe(201);
    await settle();
    expect((await doc(BACK_END)).state).toBe('PROPOSED');

    const outcomes = await db.receiptOutcome.findMany({
      where: { proposalKind: 'DESIGN_DOC_PROPOSAL' },
    });
    expect(outcomes.map((o) => [o.kind, o.reason])).toEqual([
      ['DECLINE', 'Use a queue, not polling'],
    ]);
  });

  test('a revert follows the restored version, and the AI proposes the update it needs', async () => {
    await writeSpec(SPEC);
    await approve((await doc(BACK_END)).proposal?.id ?? '');
    await writeSpec(SPEC_BACK_END_CHANGED);
    await approve((await doc(BACK_END)).proposal?.id ?? '');
    expect((await doc(BACK_END)).state).toBe('APPROVED');

    const reverted = await asBeam<DesignDocVersionView>(
      'POST',
      `/features/${FEATURE}/design-docs/${BACK_END}/versions/1/revert`,
      { baseVersion: 2 },
    );
    expect(reverted.status).toBe(201);
    expect(reverted.body).toMatchObject({
      version: 3,
      source: 'REVERT',
      revertedFrom: 1,
      specVersion: 2,
      summary: 'Reverted to v1',
    });
    await settle();
    const after = await doc(BACK_END);
    expect(after.state).toBe('STALE');
    expect(after.proposal?.reason).toBe('SPEC_CHANGED');
    // A stale base is a 409.
    const stale = await asBeam(
      'POST',
      `/features/${FEATURE}/design-docs/${BACK_END}/versions/1/revert`,
      {
        baseVersion: 2,
      },
    );
    expect(stale.status).toBe(409);
  });

  test('templates: a Project edits one, a later Platform names one, and drafts use them', async () => {
    const templates = await asPim<DesignTemplatesView>(
      'GET',
      `/projects/${PROJECT}/design-templates`,
    );
    expect(templates.body.templates.map((t) => [t.kind, t.builtIn])).toEqual([
      ['BACK_END', true],
      ['FRONT_END', true],
      ['MOBILE', true],
      ['QA', true],
    ]);
    expect(templates.body.canEdit).toBe(true);
    // Beam is no PO or Admin.
    expect(
      (await asBeam('PUT', `/projects/${PROJECT}/design-templates/BACK_END`, { markdown: '## X' }))
        .status,
    ).toBe(403);
    const saved = await asPim<DesignTemplatesView>(
      'PUT',
      `/projects/${PROJECT}/design-templates/BACK_END`,
      { markdown: '## Endpoints\n\n## Storage\n\n## Open questions' },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.templates[0]).toMatchObject({ kind: 'BACK_END', builtIn: false });

    // Flutter is added later and names the Mobile template.
    const list = (await asPim<ProjectPlatformsView>('GET', `/projects/${PROJECT}/platforms`)).body;
    const added = await asPim<ProjectPlatformsView>('PUT', `/projects/${PROJECT}/platforms`, {
      platforms: [
        ...list.platforms.map(({ position: _p, ...p }) => p),
        { name: 'Flutter', roles: ['BACKEND'], designTemplate: 'MOBILE' },
      ],
    });
    expect(added.status).toBe(200);
    const flutter = added.body.platforms.find((p) => p.name === 'Flutter');
    expect(flutter?.designTemplate).toBe('MOBILE');
    await asPim('PUT', `/features/${FEATURE}/platforms`, {
      platformIds: [BACK_END, flutter?.id],
    });
    await settle();
    ai.calls.length = 0;
    await writeSpec(SPEC.replace('## Front-End', '## Flutter'));
    const byName = new Map(drafts().map((d) => [d.doc.name, d]));
    expect(byName.get('Back-End')?.doc.template).toBe(
      '## Endpoints\n\n## Storage\n\n## Open questions\n',
    );
    expect(byName.get('Flutter')?.doc.template).toContain('## Push notifications');
    const flutterDoc = await doc(flutter?.id ?? '');
    expect(flutterDoc.template).toBe('MOBILE');
    // QA isn't a Platform's template.
    const refused = await asPim('PUT', `/projects/${PROJECT}/platforms`, {
      platforms: [{ name: 'QA', roles: ['QA'], designTemplate: 'QA' }],
    });
    expect(refused.status).toBe(400);

    const reset = await asPim<DesignTemplatesView>(
      'DELETE',
      `/projects/${PROJECT}/design-templates/BACK_END`,
    );
    expect(reset.body.templates[0]?.builtIn).toBe(true);
  });

  test("drafts leave Receipts in the Organization's language, and approvals are outcomes", async () => {
    await db.organization.update({ where: { id: SEED.organizationId }, data: { language: 'th' } });
    await writeSpec(SPEC);
    const call = ai.calls.find((c) => c.method === 'draftDesignDoc');
    expect(call?.language).toBe('th');
    const proposal = (await doc(BACK_END)).proposal?.id ?? '';
    await approve(proposal);
    await settle();
    const receipt = await db.receipt.findFirst({
      where: { task: 'draftDesignDoc', proposalId: proposal },
    });
    expect(receipt).toMatchObject({
      promptName: 'draft-design-doc',
      taskKind: 'DESIGN_DOCS',
      proposalKind: 'DESIGN_DOC_PROPOSAL',
      outputKind: 'DESIGN_DOC_PROPOSAL',
      redraft: 1,
      success: true,
    });
    const outcome = await db.receiptOutcome.findFirst({ where: { proposalId: proposal } });
    expect(outcome).toMatchObject({ kind: 'APPROVE', receiptId: receipt?.id, actorId: beam.id });
  });

  test('the Inbox asks each approver for their Design Docs, and the Decision Graph draws them', async () => {
    await writeSpec(SPEC);
    const inbox = async (as: typeof asPim) =>
      (await as<InboxItem[]>('GET', '/inbox')).body
        .filter((i) => i.kind === 'APPROVE_DESIGN_DOC')
        .map((i) => (i.kind === 'APPROVE_DESIGN_DOC' ? i.designDoc.name : ''))
        .sort();
    expect(await inbox(asBeam)).toEqual(['Back-End']);
    expect(await inbox(asPim)).toEqual(['Front-End', 'QA']);
    await approve((await doc(BACK_END)).proposal?.id ?? '');
    expect(await inbox(asBeam)).toEqual([]);

    await writeSpec(SPEC_BACK_END_CHANGED);
    const graph = await asPim<DecisionGraphView>('GET', `/features/${FEATURE}/decision-graph`);
    expect(graph.status).toBe(200);
    expect(graph.body.designDocs.map((d) => [d.name, d.stale, d.versions.length])).toEqual([
      ['Back-End', true, 1],
      ['Front-End', false, 0],
      ['QA', false, 0],
    ]);
    expect(graph.body.designDocs[0]?.versions[0]).toMatchObject({ version: 1, specVersion: 2 });
    expect(graph.body.designDocs[0]?.pending).toMatchObject({
      reason: 'SPEC_CHANGED',
      specVersion: 3,
    });
  });

  test('reading is for the Organization; an unknown key or a Feature without a Spec is handled', async () => {
    const other = await db.user.create({
      data: { email: 'out@else.test', name: 'Out', passwordHash: 'x' },
    });
    const outsider = as(app, other.id);
    expect((await outsider('GET', `/features/${FEATURE}/design-docs`)).status).toBe(404);
    expect((await asPim('GET', `/features/${FEATURE}/design-docs/not-a-key`)).status).toBe(400);
    expect(
      (await asPim('GET', `/features/${FEATURE}/design-docs/${SEED.platforms.mobile}`)).status,
    ).toBe(404);
    const qa = await detail('qa');
    expect(qa.versions).toEqual([]);
    expect(qa.proposal).toBeNull();
  });
});
