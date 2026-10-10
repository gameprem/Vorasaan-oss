import type { PrismaClient } from '@vorasaan/db';
import { SEED } from '@vorasaan/db/seed';
import type {
  ConversationView,
  DecisionRequestView,
  FeatureSuggestionView,
  GrillingView,
  SpecProposalView,
} from '@vorasaan/shared';
import type { AiTask } from '../ai/ai.config.ts';
import type { AiPort } from '../ai/ai.port.ts';
import { TASK_SKILLS } from '../ai/prompts.ts';
import { PromptReplay } from '../prompt-versions/replay.ts';
import { NEEDLE_PARAGRAPH, NEEDLE_QUESTION } from '../retrieval/large-project.fixture.ts';
import type { TestApp } from '../test/app.ts';
import { as } from '../test/http.ts';
import { measuringAiPort, type PromptMeasure } from './prompt-tokens.ts';

// The product's own AI calls on a seeded Organization (ticket 0076): every task with its
// real context (retrieval, the Brief, the Guidelines, history), measured from the
// Receipts each call leaves, plus a replay of the approved ones (ticket 0071). Run on the
// small large Organization (ticket 0073), whose Feature "Async checkout" carries the
// large-project fixture's handbook, with the FakeAiPort answering.

const { pim, beam } = SEED.users;
const FEATURE = SEED.featureId;
const PROJECT = SEED.projectId;

/** Feature Guidelines for the fit check and every foundation (the seed has none). */
export const SCENARIO_GUIDELINES = [
  {
    title: 'Serves a checkout KPI',
    description: 'Moves checkout conversion or payment success rate; say which and by how much.',
    kind: 'KPI',
    required: true,
  },
  {
    title: 'Keeps PCI scope',
    description: 'Card data never touches our servers; only the payment provider stores it.',
    kind: 'CONSTRAINT',
    required: true,
  },
  {
    title: 'Rollout plan',
    description: 'A staged rollout with a kill switch.',
    kind: 'REQUIRED_SECTION',
    required: false,
  },
] as const;

/** The tokens of one task's calls in a run, from their Receipts. */
export type TaskTokens = {
  task: AiTask;
  calls: number;
  /** Mean input tokens per call (the Receipts' `inputTokens`). */
  input: number;
  /** Mean of what a provider could cache and of what it can't, per call. */
  cacheable: number;
  uncached: number;
};

export type ScenarioReport = {
  tasks: TaskTokens[];
  /** Replays of the approved Receipts, scored against what people approved. */
  replay: { prompt: string; cases: number; score: number; input: number }[];
  /** Whether the Choices' context still carried the fixture's needle paragraph. */
  foundNeedle: boolean;
};

/** Wraps the app's fake in the measuring port; keep the returned list to read the measures. */
export function measuringEngine(measures: PromptMeasure[]) {
  return (fake: AiPort) => measuringAiPort(fake, { onMeasure: (m) => measures.push(m) });
}

async function ok<T>(res: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const { status, body } = await res;
  if (status !== 200 && status !== 201) {
    throw new Error(`${what} answered ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/**
 * Runs every workflow once on the seeded data, as Pim (Admin, PO and Role Owner) and
 * Beam (the Raiser), and reads the Receipts. `measures` is the list the measuring engine
 * fills (for what can be cached); the seeded data must be fresh.
 */
export async function runTokenScenarios(
  testApp: TestApp,
  db: PrismaClient,
  measures: PromptMeasure[],
): Promise<ScenarioReport> {
  const { app } = testApp;
  const asPim = as(app, pim.id);
  const asBeam = as(app, beam.id);
  await ok(
    asPim('PUT', '/settings/feature-guidelines', { criteria: SCENARIO_GUIDELINES }),
    'Guidelines',
  );

  // A Decision Request: Choices, a Redraft of them, a Decision, its Spec Proposal and a Redraft.
  const draft = await ok(
    asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: FEATURE,
      kind: 'BLOCKER',
      title: NEEDLE_QUESTION.title,
      description: NEEDLE_QUESTION.description,
    }),
    'Raise',
  );
  const choicesCall = testApp.ai.calls.find((c) => c.method === 'generateChoices');
  const choicesContext = (choicesCall?.input as Parameters<AiPort['generateChoices']>[0])?.context;
  const foundNeedle = (choicesContext ?? []).some((b) => b.text.includes(NEEDLE_PARAGRAPH));
  await ok(
    asBeam('POST', `/decision-requests/${draft.id}/choices/request-changes`, {
      feedback: 'Add the cost of each Choice in THB',
    }),
    'Choices: Request changes',
  );
  const open = await ok(
    asBeam<DecisionRequestView>('POST', `/decision-requests/${draft.id}/submit`, {
      deciderRole: 'PO',
    }),
    'Submit',
  );
  const choice = open.choices[0];
  if (!choice) throw new Error('No Choices to decide with');
  const decided = await ok(
    asPim<{ proposal: SpecProposalView | null }>('POST', `/decision-requests/${open.id}/decision`, {
      choiceId: choice.id,
    }),
    'Decide',
  );
  const proposal = decided.proposal;
  if (!proposal) throw new Error('No Spec Proposal after the Decision');
  await ok(
    asPim('POST', `/spec-proposals/${proposal.id}/request-changes`, {
      feedback: 'Mention the 22:30 cutoff in the acceptance criteria',
    }),
    'Spec Proposal: Request changes',
  );
  await ok(asPim('POST', `/spec-proposals/${proposal.id}/approve`, { redraft: 2 }), 'Approve');

  // A second request decided as drafted: another approved Choices Receipt to replay.
  const second = await ok(
    asBeam<DecisionRequestView>('POST', '/decision-requests', {
      featureId: FEATURE,
      kind: 'QUESTION',
      title: 'How long before a pending payment counts as failed?',
      description: 'The Spec leaves the timeout open. The provider can take up to 24h.',
    }),
    'Raise a second',
  );
  const secondOpen = await ok(
    asBeam<DecisionRequestView>('POST', `/decision-requests/${second.id}/submit`, {
      deciderRole: 'PO',
    }),
    'Submit a second',
  );
  const secondChoice = secondOpen.choices[1] ?? secondOpen.choices[0];
  if (!secondChoice) throw new Error('No Choices on the second request');
  const secondDecided = await ok(
    asPim<{ proposal: SpecProposalView | null }>(
      'POST',
      `/decision-requests/${secondOpen.id}/decision`,
      { choiceId: secondChoice.id },
    ),
    'Decide a second',
  );
  if (secondDecided.proposal) {
    await ok(asPim('POST', `/spec-proposals/${secondDecided.proposal.id}/approve`), 'Approve 2');
  }

  // Conversations: three turns on the Feature, one on the Project.
  const conversation = await ok(
    asPim<ConversationView>('POST', '/conversations', {
      scope: { kind: 'FEATURE', featureId: FEATURE },
      content: `${NEEDLE_QUESTION.title} What does the handbook say?`,
    }),
    'Feature Conversation',
  );
  for (const content of [
    'What is still open on this Feature?',
    'Which Decisions changed the Spec most recently?',
  ]) {
    await ok(
      asPim('POST', `/conversations/${conversation.id}/messages`, { content }),
      'Feature Conversation turn',
    );
  }
  await ok(
    asPim('POST', '/conversations', {
      scope: { kind: 'PROJECT', projectId: PROJECT },
      content: 'Which Features touch payments, and what is still undecided on them?',
    }),
    'Project Conversation',
  );

  // A Spec drafted from the Feature's Attachments.
  await ok(
    asPim('POST', `/features/${FEATURE}/spec-proposals/from-attachments`),
    'Spec from Attachments',
  );

  // Acceptance criteria for a target Platform that isn't QA ready (ticket 0051): the large
  // Organization's Features target Back-End, whose section the Spec doesn't have yet.
  await ok(
    asPim('POST', `/features/${FEATURE}/coverage/acceptance-criteria`, {
      platformId: SEED.platforms.backEnd,
    }),
    'Acceptance criteria',
  );

  // Feature Suggestions, a Redraft of one, a first Spec of another, and the fit check.
  const suggestions = await ok(
    asPim<FeatureSuggestionView[]>('POST', `/projects/${PROJECT}/feature-suggestions/generate`, {
      count: 3,
    }),
    'Feature Suggestions',
  );
  const [first, other] = suggestions;
  if (first) {
    await ok(
      asPim('POST', `/feature-suggestions/${first.id}/request-changes`, {
        feedback: 'Make it smaller: one Platform only',
      }),
      'Suggestion: Request changes',
    );
  }
  if (other) {
    await ok(
      asPim('POST', `/feature-suggestions/${other.id}/accept`, { teamId: SEED.teamId }),
      'Accept a suggestion',
    );
  }
  await ok(
    asPim('POST', `/projects/${PROJECT}/feature-fit`, {
      title: 'Save cards for one-tap checkout',
      description: 'Store the customer card number so the next checkout is one tap.',
    }),
    'Fit check',
  );

  // A Grilling: its first round's questions, then an answer with a follow-up decided.
  const grilling = await ok(
    asPim<GrillingView>('POST', `/projects/${PROJECT}/grillings`),
    'Grilling',
  );
  const question = grilling.rounds.flatMap((r) => r.questions)[0];
  if (question) {
    await ok(
      asPim('POST', `/grillings/${grilling.id}/questions/${question.id}/answer`, {
        answer:
          'Payment success rate from 92% to 97% by Q3; failed PromptPay payments are the KPI.',
      }),
      'Grilling answer',
    );
  }

  await testApp.drainIndexing();
  await testApp.receipts.drain();
  await testApp.proposals.drain();

  // The replay of the approved Receipts, through the same measuring engine.
  const replay: ScenarioReport['replay'] = [];
  const replays = app.get(PromptReplay);
  const engine = measuringAiPort(testApp.ai);
  for (const prompt of ['generate-choices', 'draft-spec-proposal'] as const) {
    const cases = await replays.cases(prompt);
    let score = 0;
    let input = 0;
    for (const c of cases) {
      const output = await c.run(engine, {
        language: c.language,
        onUsage: (u) => {
          input += u.inputTokens ?? 0;
        },
      });
      score += c.score(output).score;
    }
    replay.push({
      prompt,
      cases: cases.length,
      score: cases.length ? score / cases.length : 0,
      input: cases.length ? Math.round(input / cases.length) : 0,
    });
  }

  const receipts = await db.receipt.findMany({
    where: { evalRunId: null },
    select: { task: true, inputTokens: true },
  });
  const tasks = new Map<AiTask, { calls: number; input: number }>();
  for (const r of receipts) {
    const t = tasks.get(r.task as AiTask) ?? { calls: 0, input: 0 };
    t.calls++;
    t.input += r.inputTokens ?? 0;
    tasks.set(r.task as AiTask, t);
  }
  const cacheOf = new Map<AiTask, { cacheable: number; uncached: number; n: number }>();
  for (const m of measures) {
    const c = cacheOf.get(m.task) ?? { cacheable: 0, uncached: 0, n: 0 };
    c.cacheable += m.cacheable;
    c.uncached += m.uncached;
    c.n++;
    cacheOf.set(m.task, c);
  }
  const order = Object.keys(TASK_SKILLS) as AiTask[];
  return {
    tasks: [...tasks.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([task, t]) => {
        const c = cacheOf.get(task);
        return {
          task,
          calls: t.calls,
          input: Math.round(t.input / t.calls),
          cacheable: c ? Math.round(c.cacheable / c.n) : 0,
          uncached: c ? Math.round(c.uncached / c.n) : 0,
        };
      }),
    replay,
    foundNeedle,
  };
}
