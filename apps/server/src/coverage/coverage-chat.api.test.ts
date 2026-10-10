import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type {
  ActionCardView,
  ConversationView,
  FeatureCoverageView,
  ProjectPlatformsView,
  SpecVersionView,
} from '@vorasaan/shared';
import type { ChatChunk, PlatformForAi } from '../ai/ai.port.ts';
import { type FakeAiPort, fakeMissingSectionsNote } from '../ai/fake-ai.port.ts';
import { chatPrompt } from '../ai/prompts.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim } = SEED.users;
const FEATURE = SEED.featureId;
const PROJECT = SEED.projectId;

const BACK_END_ONLY = `# Async checkout

## Goal
Let customers leave checkout before the provider confirms.

## Back-End
POST /payments answers 202 and polls PayFast.

## Out of scope
- Refunds.
`;

const WITH_FLUTTER = `${BACK_END_ONLY}
## Flutter
- Open question for MOBILE: what must Flutter show while the payment is pending?
`;

type ChatInput = Parameters<FakeAiPort['chat']>[0];

describe('In chat, the AI proposes adding a missing Platform section (ticket 0052)', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let ai: FakeAiPort;
  let db: PrismaClient;
  let asPim: ReturnType<typeof as>;

  const chatInputs = () =>
    ai.calls.filter((c) => c.method === 'chat').map((c) => c.input as ChatInput);

  async function writeSpec(markdown: string) {
    const versions = await asPim<SpecVersionView[]>('GET', `/features/${FEATURE}/spec-versions`);
    const res = await asPim('POST', `/features/${FEATURE}/spec-versions`, {
      markdown,
      baseVersion: versions.body[0]?.version ?? 0,
    });
    expect(res.status).toBe(201);
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

  function talk(scope: object, content: string) {
    return asPim<ConversationView>('POST', '/conversations', { scope, content });
  }
  const feature = { kind: 'FEATURE', featureId: FEATURE };

  beforeAll(async () => {
    testApp = await createTestApp();
    ({ app, ai } = testApp);
    db = createTestPrisma();
    asPim = as(app, pim.id);
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
    ai.chatScript.length = 0;
    // The seeded Project's Platforms plus Flutter (MOBILE); the Feature targets Back-End and
    // Flutter, and its Spec has a Back-End section only.
    const list = (await asPim<ProjectPlatformsView>('GET', `/projects/${PROJECT}/platforms`)).body;
    const added = await asPim<ProjectPlatformsView>('PUT', `/projects/${PROJECT}/platforms`, {
      platforms: [
        ...list.platforms.map(({ position: _p, ...p }) => p),
        { name: 'Flutter', roles: ['MOBILE'] },
      ],
    });
    const byName = new Map(added.body.platforms.map((p) => [p.name, p.id]));
    const targeted = await asPim('PUT', `/features/${FEATURE}/platforms`, {
      platformIds: [byName.get('Back-End'), byName.get('Flutter')],
    });
    expect(targeted.status).toBe(200);
    await writeSpec(BACK_END_ONLY);
  });

  test('a Feature Conversation gets the target Platforms the Spec has no section for, fenced in its prompt', async () => {
    const res = await talk(feature, 'What does the Spec still lack?');
    expect(res.status).toBe(201);
    const flutter: PlatformForAi = { name: 'Flutter', roles: ['MOBILE'] };
    const [input] = chatInputs();
    expect(input?.missingSections).toEqual([flutter]);
    // The fake says so, which is what a person sees in the browser.
    const reply = res.body.messages.at(-1)?.content ?? '';
    expect(reply).toContain(fakeMissingSectionsNote([flutter]));

    // The prompt holds them in a <platforms> block, with the rule; without any, neither.
    const prompt = (await chatPrompt(input as ChatInput)).text;
    expect(prompt).toContain('## Missing Platform sections');
    expect(prompt).toContain('<platforms>\n- Flutter (MOBILE)\n</platforms>');
    const without = (await chatPrompt({ ...(input as ChatInput), missingSections: [] })).text;
    expect(without).not.toContain('Missing Platform sections');
    expect(without).not.toContain('<platforms>');
  });

  test('a Project Conversation, or a Platform whose "Spec section" check is off, gets none', async () => {
    await talk({ kind: 'PROJECT', projectId: PROJECT }, 'Hello');
    await setFlutter({ specSection: false });
    await talk(feature, 'Hello again');
    const [onProject, onFeature] = chatInputs();
    expect(onProject?.missingSections).toBeUndefined();
    expect(onFeature?.missingSections).toBeUndefined();
  });

  test('"Add a Flutter section" becomes a Spec Proposal Action Card; approving it covers the section', async () => {
    const chunks: ChatChunk[] = [
      { type: 'text', delta: 'I drafted a Flutter section. ' },
      {
        type: 'tool-call',
        call: {
          id: 'call-flutter',
          name: 'draftSpecProposal',
          args: { proposedMarkdown: WITH_FLUTTER, summary: 'Adds a Flutter section.' },
        },
      },
    ];
    ai.scriptChat({ chunks }, { chunks: [{ type: 'text', delta: 'It waits for your approval.' }] });
    const res = await talk(feature, 'Add a Flutter section');
    expect(res.status).toBe(201);
    const card = res.body.actionCards[0];
    expect(card?.kind).toBe('SPEC_PROPOSAL');
    expect(card?.status).toBe('PROPOSED');

    // Nothing is covered until a person approves the card.
    const before = await asPim<FeatureCoverageView>('GET', `/features/${FEATURE}/coverage`);
    const flutterBefore = before.body.platforms.find((p) => p.platform.name === 'Flutter');
    expect(flutterBefore?.missing.map((m) => m.check)).toContain('SPEC_SECTION');

    const approved = await asPim<ActionCardView>('POST', `/action-cards/${card?.id}/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('APPROVED');
    const after = await asPim<FeatureCoverageView>('GET', `/features/${FEATURE}/coverage`);
    const flutterAfter = after.body.platforms.find((p) => p.platform.name === 'Flutter');
    expect(flutterAfter?.missing.map((m) => m.check)).not.toContain('SPEC_SECTION');

    // The next turn no longer offers it.
    ai.calls.length = 0;
    await asPim('POST', `/conversations/${res.body.id}/messages`, { content: 'Thanks' });
    expect(chatInputs()[0]?.missingSections).toBeUndefined();
  });
});
