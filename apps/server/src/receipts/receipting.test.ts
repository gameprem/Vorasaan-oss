import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Prisma, PrismaClient } from '@vorasaan/db';
import type { ChoiceDraft } from '@vorasaan/shared';
import { skillVersion } from '@vorasaan/skills';
import { AI_TASKS, type AiTask } from '../ai/ai.config.ts';
import type {
  AiCallOptions,
  AiPort,
  ContextBlock,
  ModelChoice,
  ReceiptLink,
  RedraftFeedbackForAi,
  RequestForAi,
} from '../ai/ai.port.ts';
import { FAKE_USAGE, FakeAiPort } from '../ai/fake-ai.port.ts';
import { TASK_SKILLS } from '../ai/prompts.ts';
import { emptyMemory } from '../ai/workflow-memory.ts';
import { createTestPrisma, prepareTestDatabase, truncateAll } from '../test/database.ts';
import { FakeClock } from '../test/fake-clock.ts';
import { ReceiptingAiPort } from './receipting.ai-port.ts';
import { ReceiptsService } from './receipts.service.ts';

// Ticket 0070: every AI call leaves one Receipt, whatever the task, written off the
// request path. The calls below are a Record over every AI task, so a new task fails
// this file until it is added here.

const request: RequestForAi = {
  kind: 'BLOCKER',
  raiserRole: 'FRONTEND',
  title: 'Where does Retry go?',
  description: 'The order card has no room.',
};
const context: ContextBlock[] = [];
const project = { name: 'Banking' };
const feature = { title: 'Checkout v2', description: 'Pay later.' };
const suggestion = {
  title: 'Payment alerts',
  rationale: 'People miss failed payments.',
  businessValue: 'Fewer tickets.',
  effort: 'LOW' as const,
  risk: 'LOW' as const,
};
const choices: ChoiceDraft[] = [
  {
    label: 'A',
    title: 'Retry button',
    description: 'On the card.',
    impactScope: 'Spec',
    impactTime: '+1 day',
    impactRisk: 'Low',
  },
];
const feedback: RedraftFeedbackForAi = {
  current: 1,
  feedback: { redraft: 1, feedback: 'Shorter please', pointer: null },
  earlier: [],
};

const CALLS: Record<AiTask, (ai: AiPort, options: AiCallOptions) => Promise<unknown>> = {
  generateChoices: (ai, o) => ai.generateChoices({ specMarkdown: '# Spec', request, context }, o),
  draftSpecProposal: (ai, o) =>
    ai.draftSpecProposal(
      { specMarkdown: '# Spec', request, decision: { kind: 'custom', answer: 'Yes' }, context },
      o,
    ),
  summarizeAttachment: (ai, o) =>
    ai.summarizeAttachment({ attachment: { title: 'Notes', source: 'FILE', text: 'Text' } }, o),
  draftSpecFromAttachments: (ai, o) =>
    ai.draftSpecFromAttachments({ feature, specMarkdown: '', context }, o),
  grillingQuestions: (ai, o) =>
    ai.grillingQuestions(
      {
        project,
        round: 'BUSINESS',
        role: 'PO',
        projectContext: [],
        guidelines: [],
        memory: emptyMemory(),
      },
      o,
    ),
  grillingFollowUp: (ai, o) =>
    ai.grillingFollowUp(
      {
        project,
        round: 'BUSINESS',
        role: 'PO',
        question: 'Who uses it?',
        answer: 'Shoppers who pay later on their phones',
        followUps: [],
        remaining: 2,
      },
      o,
    ),
  draftBriefFromGrilling: (ai, o) =>
    ai.draftBriefFromGrilling(
      {
        project,
        briefMarkdown: '',
        projectContext: [],
        guidelines: [],
        memory: emptyMemory(),
        answers: [],
      },
      o,
    ),
  suggestFeatures: (ai, o) =>
    ai.suggestFeatures(
      {
        project,
        count: 2,
        projectContext: [],
        guidelines: [],
        decisions: [],
        dismissed: [],
        pending: [],
      },
      o,
    ),
  draftSpecFromSuggestion: (ai, o) =>
    ai.draftSpecFromSuggestion({ project, suggestion, projectContext: [], guidelines: [] }, o),
  checkFeatureFit: (ai, o) =>
    ai.checkFeatureFit({ project, feature, projectContext: [], guidelines: [] }, o),
  chat: async (ai, o) => {
    const chunks = [];
    for await (const chunk of ai.chat(
      {
        scope: { kind: 'FEATURE', project, feature },
        context,
        foundation: { brief: null, guidelines: [] },
        summary: '',
        recentMessages: [{ role: 'USER', content: 'Hello' }],
        tools: [],
      },
      o,
    )) {
      chunks.push(chunk);
    }
    return chunks;
  },
  summarizeConversation: (ai, o) =>
    ai.summarizeConversation(
      {
        scope: { kind: 'PROJECT', project },
        summary: '',
        messages: [{ role: 'USER', content: 'We agreed on polling.' }],
        actionCards: [],
      },
      o,
    ),
  redraftChoices: (ai, o) =>
    ai.redraftChoices({ ...feedback, specMarkdown: '# Spec', request, choices, context }, o),
  redraftSpecProposal: (ai, o) =>
    ai.redraftSpecProposal(
      { ...feedback, feature, specMarkdown: '', proposedMarkdown: '# Draft', context },
      o,
    ),
  redraftBriefProposal: (ai, o) =>
    ai.redraftBriefProposal(
      {
        ...feedback,
        project,
        briefMarkdown: '',
        proposedMarkdown: '# Brief',
        projectContext: [],
        guidelines: [],
      },
      o,
    ),
  redraftFeatureSuggestion: (ai, o) =>
    ai.redraftFeatureSuggestion(
      { ...feedback, project, suggestion, projectContext: [], guidelines: [] },
      o,
    ),
  analyzeFeedback: (ai, o) =>
    ai.analyzeFeedback(
      {
        prompt: { name: 'generate-choices', tasks: ['generateChoices'] },
        template: '# Prompt',
        calls: 1,
        cases: [],
      },
      o,
    ),
  proposePromptVersion: (ai, o) =>
    ai.proposePromptVersion(
      {
        prompt: { name: 'generate-choices', tasks: ['generateChoices'] },
        template: '# Prompt',
        placeholders: [],
        patterns: [],
      },
      o,
    ),
  redraftPromptVersion: (ai, o) =>
    ai.redraftPromptVersion(
      {
        ...feedback,
        prompt: { name: 'generate-choices', tasks: ['generateChoices'] },
        template: '# Prompt',
        rationale: 'Shorter.',
        active: '# Prompt',
        placeholders: [],
        patterns: [],
      },
      o,
    ),
};

const TASKS = Object.keys(TASK_SKILLS) as AiTask[];

const MODEL: ModelChoice = {
  source: 'APPROVED_MODEL',
  approvedModelId: '00000000-0000-4000-8000-000000000001',
  integrationId: '00000000-0000-4000-8000-000000000002',
  provider: {
    provider: 'ANTHROPIC',
    model: 'test-model-fast',
    apiKey: 'sk-ant-secret-key-1234567890',
    baseUrl: null,
  },
  name: 'test-model-fast',
  contextWindow: 32_000,
};

/** A ReceiptsService whose database write can be made to fail or hang. */
class TestReceipts extends ReceiptsService {
  write: ((data: Prisma.ReceiptUncheckedCreateInput) => Promise<unknown>) | null = null;
  protected override persist(data: Prisma.ReceiptUncheckedCreateInput) {
    return this.write ? this.write(data) : super.persist(data);
  }
}

describe('a Receipt per AI call (0070)', () => {
  let db: PrismaClient;
  let clock: FakeClock;
  let fake: FakeAiPort;
  let receipts: TestReceipts;
  let ai: ReceiptingAiPort;
  let userId: string;

  beforeAll(async () => {
    await prepareTestDatabase();
    db = createTestPrisma();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await db.organization.create({ data: { name: 'Acme' } });
    userId = (
      await db.user.create({
        data: { email: 'pim@example.com', name: 'Pim', passwordHash: 'x' },
      })
    ).id;
    clock = new FakeClock();
    clock.set('2026-10-01T09:00:00.000Z');
    fake = new FakeAiPort();
    receipts = new TestReceipts(db, clock);
    ai = new ReceiptingAiPort(fake, receipts, clock);
  });

  test('every AI task is called here', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...TASKS].sort());
  });

  for (const task of TASKS) {
    test(`${task}: one Receipt with its task, prompt, Prompt Version, model, usage and link`, async () => {
      const link: ReceiptLink = {
        requestedById: userId,
        output: { kind: 'CHOICES', id: '00000000-0000-4000-8000-0000000000aa' },
        proposal: { kind: 'CHOICES', id: '00000000-0000-4000-8000-0000000000aa', redraft: 1 },
      };
      await CALLS[task](ai, { model: MODEL, language: 'th', receipt: link });
      await receipts.drain();

      const rows = await db.receipt.findMany();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        task,
        taskKind: AI_TASKS[task].kind,
        promptName: TASK_SKILLS[task],
        promptVersion: await skillVersion(TASK_SKILLS[task]),
        modelSource: 'APPROVED_MODEL',
        approvedModelId: MODEL.approvedModelId,
        modelName: 'test-model-fast',
        providerKind: 'ANTHROPIC',
        language: 'th',
        success: true,
        error: null,
        outputKind: 'CHOICES',
        proposalKind: 'CHOICES',
        redraft: 1,
        requestedById: userId,
        createdAt: new Date('2026-10-01T09:00:00.000Z'),
      });
      expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
      if (task === 'chat') {
        // A chat reply reports its prompt by the fake's counter.
        expect(row?.inputTokens).toBeGreaterThan(0);
        expect(row?.outputTokens).toBeGreaterThan(0);
        expect(row?.cacheWriteTokens).toBe(0);
      } else {
        expect(row).toMatchObject(FAKE_USAGE);
      }
    });
  }

  test('a call retried after an invalid answer sums the usage of both requests', async () => {
    const twice: AiPort = Object.assign(Object.create(fake), {
      generateChoices: async (input: unknown, o?: AiCallOptions) => {
        o?.onUsage?.({ ...FAKE_USAGE });
        return fake.generateChoices(input as never, o);
      },
    });
    await new ReceiptingAiPort(twice, receipts, clock).generateChoices(
      { specMarkdown: '', request, context },
      {},
    );
    await receipts.drain();
    const row = await db.receipt.findFirstOrThrow();
    expect(row.inputTokens).toBe(2 * (FAKE_USAGE.inputTokens ?? 0));
    expect(row.cacheReadTokens).toBe(2 * (FAKE_USAGE.cacheReadTokens ?? 0));
  });

  test('a failed call leaves a Receipt with its error, the key and any email masked', async () => {
    fake.failures.push(
      new Error('401 from provider: bad key sk-ant-secret-key-1234567890 for pim@example.com'),
    );
    await expect(CALLS.generateChoices(ai, { model: MODEL })).rejects.toThrow('401');
    await receipts.drain();
    const row = await db.receipt.findFirstOrThrow();
    expect(row.success).toBe(false);
    expect(row.error).toContain('401 from provider');
    expect(row.error).not.toContain('sk-ant-secret');
    expect(row.error).not.toContain('pim@example.com');
  });

  test('a chat reply that fails mid-stream leaves a failed Receipt', async () => {
    fake.scriptChat({ chunks: [{ type: 'text', delta: 'Hal' }], error: new Error('stream cut') });
    await expect(CALLS.chat(ai, {})).rejects.toThrow('stream cut');
    await receipts.drain();
    const row = await db.receipt.findFirstOrThrow();
    expect(row).toMatchObject({ task: 'chat', success: false });
    expect(row.error).toContain('stream cut');
  });

  test('counting tokens is not an AI call: no Receipt', async () => {
    await ai.countTokens({ system: 'Hi', messages: [] });
    await receipts.drain();
    expect(await db.receipt.count()).toBe(0);
  });

  test('with collection off, no Receipt is written', async () => {
    await db.organization.updateMany({ data: { receiptsEnabled: false } });
    for (const task of TASKS) await CALLS[task](ai, {});
    await receipts.drain();
    expect(await db.receipt.count()).toBe(0);
  });

  test('a failing Receipt write never fails the call, and a hanging one never delays it', async () => {
    receipts.write = () => Promise.reject(new Error('database is down'));
    await expect(CALLS.generateChoices(ai, {})).resolves.toBeDefined();
    await receipts.drain();

    let release = () => {};
    receipts.write = () =>
      new Promise((resolve) => {
        release = () => resolve(undefined);
      });
    const result = await Promise.race([
      CALLS.draftSpecProposal(ai, {}).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 1_000)),
    ]);
    expect(result).toBe('answered');
    // Let the hanging write go, so it doesn't outlive the test.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await receipts.drain();
    expect(await db.receipt.count()).toBe(0);
  });

  test('the daily job deletes Receipts past the retention, with their outcomes', async () => {
    await db.organization.updateMany({ data: { receiptRetentionDays: 30 } });
    const link: ReceiptLink = {
      proposal: { kind: 'SPEC_PROPOSAL', id: '00000000-0000-4000-8000-0000000000bb', redraft: 1 },
    };
    await CALLS.draftSpecProposal(ai, { receipt: link });
    await receipts.drain();
    receipts.outcome({
      kind: 'DECLINE',
      proposal: { kind: 'SPEC_PROPOSAL', id: '00000000-0000-4000-8000-0000000000bb' },
      actorId: userId,
      reason: 'Too long',
    });
    await receipts.drain();
    expect(await db.receiptOutcome.count()).toBe(1);

    clock.advance(20 * 24 * 60 * 60 * 1000);
    await CALLS.generateChoices(ai, {});
    await receipts.drain();

    clock.advance(11 * 24 * 60 * 60 * 1000);
    expect(await receipts.purge()).toEqual({ receipts: 1, outcomes: 1 });
    expect(await db.receipt.count()).toBe(1);
    expect((await db.receipt.findFirstOrThrow()).task).toBe('generateChoices');
    expect(await db.receiptOutcome.count()).toBe(0);
    expect(await receipts.purge()).toEqual({ receipts: 0, outcomes: 0 });
  });
});
