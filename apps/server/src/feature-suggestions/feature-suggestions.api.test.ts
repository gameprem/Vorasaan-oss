import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient, TeamRole } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  AcceptFeatureSuggestionResult,
  DecisionRequestView,
  EffectiveFeatureGuidelinesView,
  FeatureFitView,
  FeatureSuggestionView,
  SpecVersionView,
} from '@vorasaan/shared';
import {
  AiOutputError,
  type ContextBlock,
  type DismissedSuggestionForAi,
  type GuidelineForAi,
  type ProjectFoundationForAi,
} from '../ai/ai.port.ts';
import { BUDGET_CONFIG } from '../ai/context-budget.ts';
import type { FakeAiPort } from '../ai/fake-ai.port.ts';
import { estimateTokens } from '../retrieval/token-estimate.ts';
import { createTestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users;

type SuggestInput = {
  count: number;
  projectContext: ContextBlock[];
  guidelines: GuidelineForAi[];
  decisions: ContextBlock[];
  dismissed: DismissedSuggestionForAi[];
  pending: string[];
};

describe('Feature Suggestions', () => {
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  /** PO of a second Team ("Growth") in the seeded Project. */
  let olga: string;
  let growthTeamId: string;
  /** Another Project, with its own Team and PO (Wes). */
  let wealth: { id: string; teamId: string };
  let wes: string;
  let outsider: string;

  const asUser = (id: string) => as(app, id);
  const suggestCalls = () =>
    ai.calls.filter((c) => c.method === 'suggestFeatures').map((c) => c.input as SuggestInput);
  const generate = (by: string, body?: object, projectId: string = SEED.projectId) =>
    asUser(by)<FeatureSuggestionView[]>(
      'POST',
      `/projects/${projectId}/feature-suggestions/generate`,
      body,
    );
  const accept = (by: string, id: string, teamId: string) =>
    asUser(by)<AcceptFeatureSuggestionResult>('POST', `/feature-suggestions/${id}/accept`, {
      teamId,
    });
  const dismiss = (by: string, id: string, reason: string) =>
    asUser(by)<FeatureSuggestionView>('POST', `/feature-suggestions/${id}/dismiss`, { reason });

  async function person(name: string, organizationId: string = SEED.organizationId) {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({ data: { organizationId, userId: user.id, role: 'MEMBER' } });
    return user.id;
  }

  async function join(teamId: string, userId: string, role: TeamRole) {
    await db.teamMembership.create({ data: { teamId, userId, role } });
  }

  async function setGuidelines(titles: string[]) {
    const res = await asUser(pim.id)('PUT', '/settings/feature-guidelines', {
      criteria: titles.map((title) => ({
        title,
        description: `About ${title}.`,
        kind: 'KPI',
        required: true,
      })),
    });
    expect(res.status).toBe(200);
    const effective = await asUser(pim.id)<EffectiveFeatureGuidelinesView>(
      'GET',
      `/projects/${SEED.projectId}/feature-guidelines/effective`,
    );
    return effective.body.criteria.map((c) => c.id);
  }

  async function writeBrief(markdown: string) {
    const res = await asUser(pim.id)('POST', `/projects/${SEED.projectId}/brief-versions`, {
      markdown,
      baseVersion: 0,
    });
    expect(res.status).toBe(201);
  }

  beforeAll(async () => {
    ({ app, ai } = await createTestApp());
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    ai.calls.length = 0;
    olga = await person('Olga');
    wes = await person('Wes');
    const growth = await db.team.create({ data: { projectId: SEED.projectId, name: 'Growth' } });
    growthTeamId = growth.id;
    await join(growthTeamId, olga, 'PO');
    const project = await db.project.create({
      data: { organizationId: SEED.organizationId, name: 'Wealth' },
    });
    const team = await db.team.create({ data: { projectId: project.id, name: 'Invest' } });
    wealth = { id: project.id, teamId: team.id };
    await join(team.id, wes, 'PO');
    const other = await db.organization.create({ data: { name: 'Other Org' } });
    outsider = await person('Otto', other.id);
  });

  test('generate → accept one → a DRAFT Feature with a PENDING Spec Proposal; a dismissed reason reaches the next generation', async () => {
    const guidelineIds = await setGuidelines(['Serves a KPI', 'Keeps PCI scope']);
    await writeBrief('# Project Brief\n\n## Business goals\nGrow active payers.');

    const first = await generate(pim.id, { count: 3 });
    expect(first.status).toBe(201);
    expect(first.body.map((s) => s.title)).toEqual([
      'Suggested Feature 1',
      'Suggested Feature 2',
      'Suggested Feature 3',
    ]);
    const [one, two] = first.body;
    if (!one || !two) throw new Error('expected suggestions');
    expect(one).toMatchObject({
      projectId: SEED.projectId,
      status: 'PENDING',
      effort: 'MEDIUM',
      risk: 'LOW',
      generatedBy: { id: pim.id },
      decidedBy: null,
      featureId: null,
    });
    // The fake cites both Guidelines and an unknown handle, which is dropped.
    expect(one.servesGuidelineIds).toEqual(guidelineIds);
    expect(new Set(first.body.map((s) => s.batchId)).size).toBe(1);

    // What the AI got: the Brief first, the Guidelines with their handles.
    const [call] = suggestCalls();
    expect(call?.count).toBe(3);
    expect(call?.projectContext[0]?.source).toMatchObject({ kind: 'BRIEF_VERSION', version: 1 });
    expect(call?.guidelines.map((g) => [g.ref, g.title])).toEqual([
      ['G1', 'Serves a KPI'],
      ['G2', 'Keeps PCI scope'],
    ]);
    expect(call?.dismissed).toEqual([]);

    // Olga (PO of Growth) accepts the first into her Team.
    const accepted = await accept(olga, one.id, growthTeamId);
    expect(accepted.status).toBe(201);
    const { feature, proposal, suggestion } = accepted.body;
    expect(feature).toMatchObject({
      teamId: growthTeamId,
      title: 'Suggested Feature 1',
      status: 'DRAFT',
    });
    expect(suggestion).toMatchObject({
      status: 'ACCEPTED',
      featureId: feature.id,
      decidedBy: { id: olga },
    });
    expect(proposal).toMatchObject({
      featureId: feature.id,
      source: 'AI_SUMMARY',
      status: 'PENDING',
      approver: { id: olga },
      baseVersion: null,
    });
    expect(proposal.proposedMarkdown).toContain('# Suggested Feature 1');
    const stored = await db.feature.findUniqueOrThrow({
      where: { id: feature.id },
      include: { roleOwners: true },
    });
    expect(stored.description).toBe(one.rationale);
    expect(stored.roleOwners.map((r) => [r.userId, r.role])).toEqual([[olga, 'PO']]);
    const draftCall = ai.calls.find((c) => c.method === 'draftSpecFromSuggestion')?.input as {
      suggestion: { title: string };
      projectContext: ContextBlock[];
      guidelines: GuidelineForAi[];
    };
    expect(draftCall.suggestion.title).toBe('Suggested Feature 1');
    expect(draftCall.projectContext[0]?.source.kind).toBe('BRIEF_VERSION');
    expect(draftCall.guidelines.map((g) => g.title)).toEqual(['Serves a KPI', 'Keeps PCI scope']);

    // Olga approves the proposal: Spec v1 of the new Feature.
    const approved = await asUser(olga)<SpecVersionView>(
      'POST',
      `/spec-proposals/${proposal.id}/approve`,
    );
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ featureId: feature.id, version: 1 });

    // Pim dismisses the second, saying why.
    const dismissed = await dismiss(pim.id, two.id, '  We have no budget for native apps.  ');
    expect(dismissed.status).toBe(201);
    expect(dismissed.body).toMatchObject({
      status: 'DISMISSED',
      dismissReason: 'We have no budget for native apps.',
      decidedBy: { id: pim.id },
    });

    // The next generation sends the reason back, and the waiting one's title.
    const second = await generate(pim.id);
    expect(second.status).toBe(201);
    const next = suggestCalls()[1];
    expect(next?.count).toBe(5);
    expect(next?.dismissed).toEqual([
      {
        title: 'Suggested Feature 2',
        rationale: two.rationale,
        reason: 'We have no budget for native apps.',
      },
    ]);
    expect(next?.pending).toEqual(['Suggested Feature 3']);
    // The accepted one is now a Feature (with its Spec) in the Project context.
    expect(next?.projectContext.map((b) => b.source.title)).toContain('Spec: Suggested Feature 1');
    // Nothing already suggested, dismissed or built comes back: the fake repeats the
    // accepted one's title (a Feature now), and the server drops it.
    expect(second.body.map((s) => s.title)).toEqual([
      'Suggested Feature 4',
      'Suggested Feature 5',
      'Suggested Feature 6',
      'Suggested Feature 7',
    ]);
    const titles = second.body.map((s) => s.title);
    for (const old of ['Suggested Feature 1', 'Suggested Feature 2', 'Suggested Feature 3']) {
      expect(titles).not.toContain(old);
    }

    const list = await asUser(beam.id)<FeatureSuggestionView[]>(
      'GET',
      `/projects/${SEED.projectId}/feature-suggestions`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(7);
    const byStatus = async (status: string) =>
      (
        await asUser(beam.id)<FeatureSuggestionView[]>(
          'GET',
          `/projects/${SEED.projectId}/feature-suggestions?status=${status}`,
        )
      ).body.map((s) => s.title);
    expect(await byStatus('ACCEPTED')).toEqual(['Suggested Feature 1']);
    expect(await byStatus('DISMISSED')).toEqual(['Suggested Feature 2']);
    expect(await byStatus('PENDING')).toHaveLength(5);
  });

  test('the Decision Log reaches the AI; at most 10 suggestions; the body is optional', async () => {
    const draft = await asUser(beam.id)<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Webhook or polling?',
      description: 'The provider offers both.',
    });
    await asUser(beam.id)('POST', `/decision-requests/${draft.body.id}/submit`, {
      deciderRole: 'PO',
    });
    const decided = await asUser(pim.id)('POST', `/decision-requests/${draft.body.id}/decision`, {
      customAnswer: 'Webhooks, with polling as a fallback.',
    });
    expect(decided.status).toBe(201);

    expect((await generate(pim.id)).body).toHaveLength(5);
    const decisions = suggestCalls()[0]?.decisions ?? [];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.source).toMatchObject({
      kind: 'DECISION',
      title: 'Decision on Async checkout: Webhook or polling?',
    });
    expect(decisions[0]?.text).toContain('Webhooks, with polling as a fallback.');

    expect((await generate(pim.id, { count: 10 })).body).toHaveLength(10);
    expect((await generate(pim.id, { count: 11 })).status).toBe(400);
    expect((await generate(pim.id, { count: 0 })).status).toBe(400);
  });

  test('who may generate, list, accept and dismiss', async () => {
    // Members read; only the Project's POs and Admins generate and dismiss.
    expect((await generate(beam.id)).status).toBe(403);
    expect((await generate(wes)).status).toBe(403);
    expect((await generate(outsider)).status).toBe(403);
    expect((await generate(pim.id, {}, crypto.randomUUID())).status).toBe(404);
    const made = await generate(olga, { count: 3 });
    expect(made.status).toBe(201);
    const [a, b, c] = made.body;
    if (!a || !b || !c) throw new Error('expected suggestions');
    const list = `/projects/${SEED.projectId}/feature-suggestions`;
    expect((await asUser(beam.id)('GET', list)).status).toBe(200);
    expect((await asUser(outsider)('GET', list)).status).toBe(403);
    expect((await asUser(beam.id)('GET', `${list}?status=NOPE`)).status).toBe(400);

    expect((await dismiss(beam.id, a.id, 'No.')).status).toBe(403);
    expect((await dismiss(wes, a.id, 'No.')).status).toBe(403);
    expect((await dismiss(pim.id, a.id, '   ')).status).toBe(400);
    expect((await dismiss(pim.id, a.id, 'x'.repeat(1001))).status).toBe(400);
    expect((await dismiss(pim.id, crypto.randomUUID(), 'No.')).status).toBe(404);

    // Accept: a PO of the chosen Team, or an Admin; the Team must be in the Project.
    expect((await accept(olga, a.id, SEED.teamId)).status).toBe(403); // not Olga's Team
    expect((await accept(beam.id, a.id, SEED.teamId)).status).toBe(403);
    expect((await accept(wes, a.id, wealth.teamId)).status).toBe(422); // another Project's Team
    expect((await accept(pim.id, a.id, wealth.teamId)).status).toBe(422);
    expect((await accept(pim.id, a.id, crypto.randomUUID())).status).toBe(422);
    expect((await accept(outsider, a.id, SEED.teamId)).status).toBe(403);
    expect(await db.feature.count({ where: { title: a.title } })).toBe(0);

    // Pim is an Admin: he accepts into Growth, where he isn't a member.
    const byAdmin = await accept(pim.id, a.id, growthTeamId);
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.body.feature.teamId).toBe(growthTeamId);

    // Decided once: accepting or dismissing again is a conflict.
    expect((await accept(olga, a.id, growthTeamId)).status).toBe(409);
    expect((await dismiss(pim.id, a.id, 'Too late.')).status).toBe(409);
    expect((await dismiss(olga, b.id, 'Not now.')).status).toBe(201);
    expect((await dismiss(olga, b.id, 'Not now.')).status).toBe(409);
    expect((await accept(olga, b.id, growthTeamId)).status).toBe(409);
    expect(await db.feature.count({ where: { title: { startsWith: 'Suggested' } } })).toBe(1);
  });

  test('only a PO of the Team becomes Role Owner: an Admin outside it gets a Feature with none, and still approves', async () => {
    const [byAdmin, byPo] = (await generate(pim.id, { count: 2 })).body;
    if (!byAdmin || !byPo) throw new Error('expected suggestions');

    // Pim is an Admin but not in Growth: no Role Owner, yet he is the approver.
    const admin = await accept(pim.id, byAdmin.id, growthTeamId);
    expect(admin.status).toBe(201);
    expect(admin.body.proposal.approver).toEqual({ id: pim.id, name: 'Pim' });
    expect(await db.roleOwner.count({ where: { featureId: admin.body.feature.id } })).toBe(0);
    const approved = await asUser(pim.id)<SpecVersionView>(
      'POST',
      `/spec-proposals/${admin.body.proposal.id}/approve`,
    );
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ featureId: admin.body.feature.id, version: 1 });

    // Olga holds the PO Team Role in Growth: she becomes its PO Role Owner.
    const po = await accept(olga, byPo.id, growthTeamId);
    expect(po.status).toBe(201);
    const owners = await db.roleOwner.findMany({ where: { featureId: po.body.feature.id } });
    expect(owners.map((o) => [o.userId, o.role])).toEqual([[olga, 'PO']]);
  });

  test('two accepts at once: one Feature, one 409', async () => {
    const [s] = (await generate(pim.id, { count: 1 })).body;
    if (!s) throw new Error('expected a suggestion');
    const results = await Promise.all([
      accept(pim.id, s.id, growthTeamId),
      accept(olga, s.id, growthTeamId),
      accept(pim.id, s.id, SEED.teamId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await db.feature.count({ where: { title: s.title } })).toBe(1);
    expect(await db.specProposal.count({ where: { feature: { title: s.title } } })).toBe(1);
  });

  test('a failed AI call writes nothing: 502', async () => {
    const suggest = ai.suggestFeatures.bind(ai);
    ai.suggestFeatures = async () => {
      throw new AiOutputError('suggest-features', new Error('bad output'));
    };
    try {
      expect((await generate(pim.id)).status).toBe(502);
      expect(await db.featureSuggestion.count()).toBe(0);
    } finally {
      ai.suggestFeatures = suggest;
    }

    const [s] = (await generate(pim.id, { count: 1 })).body;
    if (!s) throw new Error('expected a suggestion');
    const draft = ai.draftSpecFromSuggestion.bind(ai);
    ai.draftSpecFromSuggestion = async () => {
      throw new Error('network down');
    };
    try {
      expect((await accept(pim.id, s.id, growthTeamId)).status).toBe(502);
      expect(await db.feature.count({ where: { teamId: growthTeamId } })).toBe(0);
      expect(await db.featureSuggestion.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({
        status: 'PENDING',
        featureId: null,
        decidedById: null,
      });
    } finally {
      ai.draftSpecFromSuggestion = draft;
    }
    expect((await accept(pim.id, s.id, growthTeamId)).status).toBe(201);
  });

  describe('fit check', () => {
    const fit = (by: string, body: object, projectId: string = SEED.projectId) =>
      asUser(by)<FeatureFitView>('POST', `/projects/${projectId}/feature-fit`, body);

    test('one line per effective Guideline, with questions for the unclear ones', async () => {
      const [kpi = '', pci = '', a11y = ''] = await setGuidelines([
        'Serves a KPI',
        'Keeps PCI scope',
        'WCAG AA',
      ]);
      // Anyone in the Organization may check, a Member too.
      const res = await fit(beam.id, {
        title: 'Card freeze',
        description: 'Serves a KPI: fewer fraud calls.',
      });
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe(SEED.projectId);
      expect(res.body.results.map((r) => [r.guidelineId, r.verdict])).toEqual([
        [kpi, 'MET'],
        [pci, 'UNCLEAR'],
        // The fake leaves the last one out: the server fills it in.
        [a11y, 'UNCLEAR'],
      ]);
      expect(res.body.results[2]).toMatchObject({
        title: 'WCAG AA',
        kind: 'KPI',
        required: true,
        reason: 'Not assessed.',
      });
      expect(res.body.questions).toEqual([
        { guidelineId: pci, question: 'How does it meet "Keeps PCI scope"?' },
        { guidelineId: a11y, question: 'How does this Feature meet "WCAG AA"?' },
      ]);
      const call = ai.calls.find((c) => c.method === 'checkFeatureFit')?.input as {
        feature: { title: string; description: string };
        guidelines: GuidelineForAi[];
      };
      expect(call.feature.title).toBe('Card freeze');
      expect(call.guidelines.map((g) => g.ref)).toEqual(['G1', 'G2', 'G3']);
      expect(await db.featureSuggestion.count()).toBe(0);
    });

    test('unknown or repeated handles from the AI are dropped; each Guideline appears once', async () => {
      const [kpi = '', pci = ''] = await setGuidelines(['Serves a KPI', 'Keeps PCI scope']);
      const original = ai.checkFeatureFit.bind(ai);
      ai.checkFeatureFit = async () => ({
        results: [
          { guideline: 'G9', verdict: 'MET', reason: 'Invented.' },
          { guideline: 'G2', verdict: 'NOT_MET', reason: 'Stores card numbers.\nSecond line.' },
          { guideline: 'g2', verdict: 'MET', reason: 'Repeated.' },
          { guideline: 'G1', verdict: 'UNCLEAR', reason: 'No KPI named.', question: 'Which KPI?' },
        ],
      });
      try {
        const res = await fit(pim.id, { title: 'Store cards' });
        expect(res.status).toBe(200);
        expect(res.body.results.map((r) => [r.guidelineId, r.verdict, r.reason])).toEqual([
          [kpi, 'UNCLEAR', 'No KPI named.'],
          [pci, 'NOT_MET', 'Stores card numbers. Second line.'],
        ]);
        expect(res.body.questions).toEqual([{ guidelineId: kpi, question: 'Which KPI?' }]);
      } finally {
        ai.checkFeatureFit = original;
      }
    });

    test('no Guidelines: nothing to check, no AI call; outsiders and bad input refused; AI failure is 502', async () => {
      const none = await fit(beam.id, { title: 'Anything' });
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ projectId: SEED.projectId, results: [], questions: [] });
      expect(ai.calls.some((c) => c.method === 'checkFeatureFit')).toBe(false);

      await setGuidelines(['Serves a KPI']);
      expect((await fit(outsider, { title: 'Anything' })).status).toBe(403);
      expect((await fit(beam.id, { title: '' })).status).toBe(400);
      expect((await fit(beam.id, { title: 'x' }, crypto.randomUUID())).status).toBe(404);
      const original = ai.checkFeatureFit.bind(ai);
      ai.checkFeatureFit = async () => {
        throw new AiOutputError('check-feature-fit', new Error('bad'));
      };
      try {
        expect((await fit(beam.id, { title: 'Anything' })).status).toBe(502);
      } finally {
        ai.checkFeatureFit = original;
      }
    });
  });

  test('Choice generation and Spec Proposal drafting get the Brief and the effective Guidelines', async () => {
    await setGuidelines(['Serves a KPI']);
    await writeBrief('# Project Brief\n\n## Business goals\nGrow active payers to 1.5M.');
    const draft = await asUser(beam.id)<DecisionRequestView>('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'BLOCKER',
      title: 'Provider has no webhook',
      description: 'Only polling is available.',
    });
    expect(draft.status).toBe(201);
    type WithFoundation = { foundation?: ProjectFoundationForAi; context: ContextBlock[] };
    const choices = ai.calls.find((c) => c.method === 'generateChoices')?.input as WithFoundation;
    expect(choices.foundation?.brief).toEqual({
      version: 1,
      markdown: '# Project Brief\n\n## Business goals\nGrow active payers to 1.5M.',
    });
    expect(choices.foundation?.guidelines.map((g) => g.title)).toEqual(['Serves a KPI']);
    // Not twice: the Brief is left out of the retrieved context.
    expect(choices.context.some((b) => b.source.kind === 'BRIEF_VERSION')).toBe(false);

    await asUser(beam.id)('POST', `/decision-requests/${draft.body.id}/submit`, {
      deciderRole: 'PO',
    });
    const decided = await asUser(pim.id)('POST', `/decision-requests/${draft.body.id}/decision`, {
      customAnswer: 'Poll every 5 seconds.',
    });
    expect(decided.status).toBe(201);
    const drafting = ai.calls.find((c) => c.method === 'draftSpecProposal')
      ?.input as WithFoundation;
    expect(drafting.foundation?.brief?.version).toBe(1);
    expect(drafting.foundation?.guidelines.map((g) => g.title)).toEqual(['Serves a KPI']);
  });

  test('a long Brief is shortened for Feature tasks', async () => {
    await writeBrief(`# Project Brief\n\n${'Goal. '.repeat(3_000)}`);
    await asUser(beam.id)('POST', '/decision-requests', {
      featureId: SEED.featureId,
      kind: 'QUESTION',
      title: 'Anything?',
      description: 'Something.',
    });
    const choices = ai.calls.find((c) => c.method === 'generateChoices')?.input as {
      foundation?: ProjectFoundationForAi;
    };
    // Cut to the foundation's share of the model's window (0060), less the Guidelines.
    const tokens = estimateTokens(choices.foundation?.brief?.markdown ?? '');
    expect(tokens).toBeLessThanOrEqual(BUDGET_CONFIG.ceilings.foundation);
    expect(tokens).toBeGreaterThan(BUDGET_CONFIG.ceilings.foundation - 500);
  });
});
