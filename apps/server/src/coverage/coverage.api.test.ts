import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  DecisionRequestView,
  FeatureCoverageView,
  GrillingView,
  PlatformCoverage,
  ProjectCoverageView,
  ProjectPlatformsView,
  SpecProposalView,
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

/** A Spec with a Back-End section (with acceptance criteria) and nothing for Flutter. */
const BACK_END_ONLY = `# Async checkout

## Goal
Let customers leave checkout before the provider confirms.

## Back-End
POST /payments answers 202 and polls PayFast.

### Acceptance criteria
- [ ] A payment is never confirmed twice.

## Out of scope
- Refunds.
`;

const FLUTTER_SECTION = `
## Flutter
Shows the order as Paying until the provider answers.
`;

const FLUTTER_CRITERIA = `
### Acceptance criteria
- [ ] Retry is one tap from the order card.
`;

describe('Coverage per Platform (ticket 0051)', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;
  let asBeam: ReturnType<typeof as>;
  let flutterId: string;

  async function coverage(): Promise<FeatureCoverageView> {
    const res = await asPim<FeatureCoverageView>('GET', `/features/${FEATURE}/coverage`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function cell(name: string): Promise<PlatformCoverage> {
    const found = (await coverage()).platforms.find((p) => p.platform.name === name);
    if (!found) throw new Error(`${name} is not a target`);
    return found;
  }

  const reasons = (c: PlatformCoverage) => c.missing.map((m) => m.check);

  async function writeSpec(markdown: string) {
    const versions = await asPim<SpecVersionView[]>('GET', `/features/${FEATURE}/spec-versions`);
    const res = await asPim('POST', `/features/${FEATURE}/spec-versions`, {
      markdown,
      baseVersion: versions.body[0]?.version ?? 0,
    });
    expect(res.status).toBe(201);
  }

  async function setRoles(userId: string, roles: TeamRole[]) {
    const res = await asPim('PUT', `/teams/${SEED.teamId}/members/${userId}`, { roles });
    expect(res.status).toBe(200);
  }

  async function setFlutter(change: Record<string, unknown>) {
    const list = (await asPim<ProjectPlatformsView>('GET', `/projects/${PROJECT}/platforms`)).body;
    const res = await asPim('PUT', `/projects/${PROJECT}/platforms`, {
      platforms: list.platforms.map(({ position: _p, ...p }) =>
        p.name === 'Flutter' ? { ...p, ...change } : p,
      ),
    });
    expect(res.status).toBe(200);
  }

  /** Beam raises a Blocker, sends it to the PO, and Pim decides it: the Spec Proposal drafts. */
  async function decideABlocker(title: string): Promise<SpecProposalView> {
    const draft = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: FEATURE,
      kind: 'BLOCKER',
      title,
      description: 'Only polling is available.',
    });
    expect(draft.status).toBe(201);
    const open = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.body.id}/submit`,
      { deciderRole: 'PO' },
    );
    expect(open.status).toBe(201);
    const decided = await asPim<{ proposal: SpecProposalView }>(
      'POST',
      `/decision-requests/${open.body.id}/decision`,
      { choiceId: open.body.choices[0]?.id },
    );
    expect(decided.status).toBe(201);
    return decided.body.proposal;
  }

  beforeAll(async () => {
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
  });

  beforeEach(async () => {
    await testApp.receipts.drain();
    await testApp.drainIndexing();
    await truncateAll(db);
    await seed(db);
    ai.calls.length = 0;
    // The seeded Project's Platforms plus Flutter (MOBILE); the Feature targets Back-End and
    // Flutter; Pim is the PO and Beam holds BACKEND.
    const list = (await asPim<ProjectPlatformsView>('GET', `/projects/${PROJECT}/platforms`)).body;
    const added = await asPim<ProjectPlatformsView>('PUT', `/projects/${PROJECT}/platforms`, {
      platforms: [
        ...list.platforms.map(({ position: _p, ...p }) => p),
        { name: 'Flutter', roles: ['MOBILE'] },
      ],
    });
    const byName = new Map(added.body.platforms.map((p) => [p.name, p.id]));
    flutterId = byName.get('Flutter') ?? '';
    const targeted = await asPim('PUT', `/features/${FEATURE}/platforms`, {
      platformIds: [byName.get('Back-End'), flutterId],
    });
    expect(targeted.status).toBe(200);
  });

  test('Flutter is missing for want of a Spec section when the Spec has only a Back-End one', async () => {
    await writeSpec(BACK_END_ONLY);
    const view = await coverage();
    expect(view.featureId).toBe(FEATURE);
    expect(view.specVersion).toBe(2);
    expect(view.covered).toBe(false);
    expect(view.platforms.map((p) => p.platform.name)).toEqual(['Back-End', 'Flutter']);
    const [backEnd, flutter] = view.platforms;
    // Back-End: a section, Beam holds BACKEND, criteria; only QA is missing (nobody holds it).
    expect(backEnd?.missing).toEqual([{ check: 'QA_READY', noCriteria: false, noQa: true }]);
    expect(flutter?.checks).toEqual([
      'SPEC_SECTION',
      'SOMEONE_TO_ASK',
      'NO_OPEN_BLOCKERS',
      'QA_READY',
    ]);
    expect(reasons(flutter as PlatformCoverage)).toContain('SPEC_SECTION');

    // With a section of its own, Flutter is no longer missing for that reason.
    await writeSpec(`${BACK_END_ONLY}${FLUTTER_SECTION}`);
    expect(reasons(await cell('Flutter'))).not.toContain('SPEC_SECTION');
  });

  test('switching off the "Spec section" check takes that reason away', async () => {
    await writeSpec(BACK_END_ONLY);
    expect(reasons(await cell('Flutter'))).toContain('SPEC_SECTION');
    await setFlutter({ specSection: false });
    const flutter = await cell('Flutter');
    expect(flutter.checks).not.toContain('SPEC_SECTION');
    expect(reasons(flutter)).not.toContain('SPEC_SECTION');
  });

  test('nobody holds MOBILE, so Flutter is missing someone to ask; a MOBILE member fixes it', async () => {
    await writeSpec(`${BACK_END_ONLY}${FLUTTER_SECTION}`);
    expect((await cell('Flutter')).missing).toContainEqual({
      check: 'SOMEONE_TO_ASK',
      roles: ['MOBILE'],
    });
    await setRoles(beam.id, ['BACKEND', 'MOBILE']);
    expect(reasons(await cell('Flutter'))).not.toContain('SOMEONE_TO_ASK');
  });

  test('QA ready needs acceptance criteria in the section and someone holding QA', async () => {
    await setRoles(beam.id, ['BACKEND', 'MOBILE']);
    await writeSpec(`${BACK_END_ONLY}${FLUTTER_SECTION}`);
    expect((await cell('Flutter')).missing).toEqual([
      { check: 'QA_READY', noCriteria: true, noQa: true },
    ]);

    // Criteria, but nobody holds QA: still missing, because nobody does.
    await writeSpec(`${BACK_END_ONLY}${FLUTTER_SECTION}${FLUTTER_CRITERIA}`);
    expect((await cell('Flutter')).missing).toEqual([
      { check: 'QA_READY', noCriteria: false, noQa: true },
    ]);

    // With a QA member in the Team, Flutter is QA ready, and covered.
    await setRoles(pim.id, ['PO', 'QA']);
    const flutter = await cell('Flutter');
    expect(flutter).toMatchObject({ covered: true, missing: [] });
    expect((await coverage()).covered).toBe(true);
  });

  test('an open Blocker naming the Platform makes it missing until it is decided', async () => {
    await setRoles(beam.id, ['BACKEND', 'MOBILE']);
    await setRoles(pim.id, ['PO', 'QA']);
    await writeSpec(`${BACK_END_ONLY}${FLUTTER_SECTION}${FLUTTER_CRITERIA}`);
    expect((await cell('Flutter')).covered).toBe(true);

    const draft = await asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: FEATURE,
      kind: 'BLOCKER',
      title: 'The flutter app crashes on Pay',
      description: 'Since SDK 4.2.',
    });
    // A DRAFT isn't open yet.
    expect((await cell('Flutter')).covered).toBe(true);
    const open = await asBeam<DecisionRequestView>(
      'POST',
      `/decision-requests/${draft.body.id}/submit`,
      { deciderRole: 'PO' },
    );
    expect((await cell('Flutter')).missing).toEqual([
      {
        check: 'NO_OPEN_BLOCKERS',
        blockers: [{ id: open.body.id, title: 'The flutter app crashes on Pay' }],
      },
    ]);
    // It doesn't name Back-End.
    expect((await cell('Back-End')).covered).toBe(true);

    await asPim('POST', `/decision-requests/${open.body.id}/decision`, {
      choiceId: open.body.choices[0]?.id,
    });
    expect((await cell('Flutter')).covered).toBe(true);
  });

  test('the Project matrix: a row per Feature, a cell per target, and the Platforms no Feature covers', async () => {
    await writeSpec(`${BACK_END_ONLY}`);
    const other = await asPim<{ id: string }>('POST', `/teams/${SEED.teamId}/features`, {
      title: 'A web receipt',
    });
    expect(other.status).toBe(201);

    const res = await asBeam<ProjectCoverageView>('GET', `/projects/${PROJECT}/coverage`);
    expect(res.status).toBe(200);
    expect(res.body.platforms.map((p) => p.name)).toEqual([
      'Back-End',
      'Front-End',
      'Mobile',
      'Flutter',
    ]);
    expect(
      res.body.features.map((f) => [f.title, f.platforms.map((p) => p.platform.name)]),
    ).toEqual([
      ['A web receipt', []],
      ['Async checkout', ['Back-End', 'Flutter']],
    ]);
    const checkout = res.body.features[1];
    expect(checkout?.specVersion).toBe(2);
    expect(checkout?.platforms).toEqual((await coverage()).platforms);
    // Back-End misses QA, Flutter misses everything, the others nobody targets.
    expect(res.body.uncovered.map((p) => p.name)).toEqual([
      'Back-End',
      'Front-End',
      'Mobile',
      'Flutter',
    ]);

    await setRoles(pim.id, ['PO', 'QA']);
    const after = await asPim<ProjectCoverageView>('GET', `/projects/${PROJECT}/coverage`);
    expect(after.body.uncovered.map((p) => p.name)).toEqual(['Front-End', 'Mobile', 'Flutter']);

    expect((await asPim('GET', `/projects/${crypto.randomUUID()}/coverage`)).status).toBe(404);
    expect((await asPim('GET', `/features/${crypto.randomUUID()}/coverage`)).status).toBe(404);
  });

  test('the input to Spec Proposal drafting contains the missing Platforms, and the draft fills or asks', async () => {
    await writeSpec(BACK_END_ONLY);
    const proposal = await decideABlocker('Provider has no webhook');
    const call = ai.calls.find((c) => c.method === 'draftSpecProposal');
    const input = call?.input as Parameters<AiPort['draftSpecProposal']>[0];
    expect(input.missingSections).toEqual([{ name: 'Flutter', roles: ['MOBILE'] }]);
    // The fake puts an open question for MOBILE in the new section.
    expect(proposal.proposedMarkdown).toContain(
      '## Flutter\n\n- Open question for MOBILE: what must Flutter do for this Feature?',
    );

    // A Platform whose "Spec section" check is off isn't asked for.
    await setFlutter({ specSection: false });
    ai.calls.length = 0;
    await decideABlocker('Provider rate limit');
    const again = ai.calls.find((c) => c.method === 'draftSpecProposal')?.input as Parameters<
      AiPort['draftSpecProposal']
    >[0];
    expect(again.missingSections).toEqual([]);
  });

  test('drafting a Spec from Attachments gets the missing Platforms too', async () => {
    await db.attachment.create({
      data: {
        featureId: FEATURE,
        source: 'URL',
        title: 'Kickoff notes',
        url: 'https://example.test/kickoff',
        snapshotText: 'Users must not wait on checkout. The Flutter app shows Paying.',
        addedById: pim.id,
      },
    });
    const res = await asPim<SpecProposalView>(
      'POST',
      `/features/${FEATURE}/spec-proposals/from-attachments`,
    );
    expect(res.status).toBe(201);
    const input = ai.calls.find((c) => c.method === 'draftSpecFromAttachments')
      ?.input as Parameters<AiPort['draftSpecFromAttachments']>[0];
    // The seeded Spec has neither section.
    expect(input.missingSections).toEqual([
      { name: 'Back-End', roles: ['BACKEND'] },
      { name: 'Flutter', roles: ['MOBILE'] },
    ]);
    expect(res.body.proposedMarkdown).toContain('## Back-End');
    expect(res.body.proposedMarkdown).toContain('## Flutter');
  });

  test('Grilling asks about the Platforms no Feature covers, once any Feature targets one', async () => {
    const started = await asPim<GrillingView>('POST', `/projects/${PROJECT}/grillings`);
    expect(started.status).toBe(201);
    const input = ai.calls.find((c) => c.method === 'grillingQuestions')?.input as Parameters<
      AiPort['grillingQuestions']
    >[0];
    expect(input.uncoveredPlatforms?.map((p) => p.name)).toEqual([
      'Back-End',
      'Front-End',
      'Mobile',
      'Flutter',
    ]);

    // A Project whose Features target nothing has said nothing about its Platforms yet.
    const fresh = await asPim<{ id: string }>('POST', '/projects', { name: 'Wealth' });
    const team = await asPim<{ id: string }>('POST', `/projects/${fresh.body.id}/teams`, {
      name: 'Invest',
    });
    expect(team.status).toBe(201);
    await asPim('PUT', `/teams/${team.body.id}/members/${pim.id}`, { roles: ['PO'] });
    ai.calls.length = 0;
    expect((await asPim('POST', `/projects/${fresh.body.id}/grillings`)).status).toBe(201);
    const none = ai.calls.find((c) => c.method === 'grillingQuestions')?.input as Parameters<
      AiPort['grillingQuestions']
    >[0];
    expect(none.uncoveredPlatforms).toEqual([]);
  });

  test("the AI drafts a Platform's acceptance criteria as a Spec Proposal; approving it makes the Platform QA ready", async () => {
    await setRoles(beam.id, ['BACKEND', 'MOBILE']);
    await setRoles(pim.id, ['PO', 'QA']);
    await writeSpec(`${BACK_END_ONLY}${FLUTTER_SECTION}`);
    expect((await cell('Flutter')).missing).toEqual([
      { check: 'QA_READY', noCriteria: true, noQa: false },
    ]);
    const url = `/features/${FEATURE}/coverage/acceptance-criteria`;

    // Only the Feature's PO or an Admin asks; the Platform must be a target.
    expect((await asBeam('POST', url, { platformId: flutterId })).status).toBe(403);
    const mobile = (
      await asPim<ProjectPlatformsView>('GET', `/projects/${PROJECT}/platforms`)
    ).body.platforms.find((p) => p.name === 'Mobile');
    expect((await asPim('POST', url, { platformId: mobile?.id })).status).toBe(422);
    // Back-End already has criteria.
    const backEnd = (await coverage()).platforms[0]?.platform.id;
    expect((await asPim('POST', url, { platformId: backEnd })).status).toBe(422);

    const res = await asPim<SpecProposalView>('POST', url, { platformId: flutterId });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('ACCEPTANCE_CRITERIA');
    expect(res.body.status).toBe('PENDING');
    const input = ai.calls.find((c) => c.method === 'draftAcceptanceCriteria')?.input as Parameters<
      AiPort['draftAcceptanceCriteria']
    >[0];
    expect(input.platform).toEqual({ name: 'Flutter', roles: ['MOBILE'] });
    expect(input.specMarkdown).toContain('## Flutter');
    expect(
      input.context.some((b) => b.source.kind === 'SPEC_VERSION' && b.scope === 'FEATURE'),
    ).toBe(false);
    // Nothing changes until a person approves.
    expect(reasons(await cell('Flutter'))).toEqual(['QA_READY']);

    const approved = await asPim<SpecVersionView>('POST', `/spec-proposals/${res.body.id}/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body.source).toBe('ACCEPTANCE_CRITERIA');
    expect(await cell('Flutter')).toMatchObject({ covered: true, missing: [] });

    // The call left a Receipt for its own task, linked to the proposal.
    await testApp.receipts.drain();
    const receipt = await db.receipt.findFirst({ where: { task: 'draftAcceptanceCriteria' } });
    expect(receipt).toMatchObject({
      promptName: 'draft-acceptance-criteria',
      taskKind: 'SPEC_PROPOSAL',
      proposalId: res.body.id,
    });
  });

  test('no acceptance criteria are drafted before the first Spec Version', async () => {
    await db.specVersion.deleteMany({ where: { featureId: FEATURE } });
    const res = await asPim('POST', `/features/${FEATURE}/coverage/acceptance-criteria`, {
      platformId: flutterId,
    });
    expect(res.status).toBe(422);
    expect(ai.calls.some((c) => c.method === 'draftAcceptanceCriteria')).toBe(false);
  });
});
