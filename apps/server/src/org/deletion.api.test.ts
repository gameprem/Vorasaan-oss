import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@vorasaan/db';
import { SEED, seed } from '@vorasaan/db/seed';
import type { ServerEvent } from '@vorasaan/shared';
import { EventBus } from '../inbox/event-bus.ts';
import { IndexingService } from '../retrieval/indexing.service.ts';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.ts';
import { createTestApp, type TestApp } from '../test/app.ts';
import { createTestPrisma, truncateAll } from '../test/database.ts';
import { as } from '../test/http.ts';

const { pim, beam } = SEED.users; // Pim: Admin and the seeded Feature's PO. Beam: Member, Backend.

/**
 * Deleting a Feature or a Project (ticket 0049): its rows cascade, its stored Attachment
 * files go once the delete commits, what the Learning Loop keeps survives, and the people
 * it concerns hear of it.
 */
describe('Deleting a Feature or a Project', () => {
  let testApp: TestApp;
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let storageDir: string;
  let bus: EventBus;

  const storage = () => app.get<FileStorage>(FILE_STORAGE);
  const filesUnder = (dir: string) =>
    readdir(join(storageDir, 'attachments', dir), { recursive: true }).catch(() => []);

  async function member(name: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const user = await db.user.create({
      data: { email: `${name.toLowerCase()}@acme.test`, name, passwordHash: 'x' },
    });
    await db.orgMembership.create({
      data: { organizationId: SEED.organizationId, userId: user.id, role },
    });
    return user;
  }

  /** A stored Attachment file on a Feature (or a Project), as an upload leaves it. */
  async function storedFile(where: { featureId: string } | { projectId: string }) {
    const id = crypto.randomUUID();
    const key =
      'featureId' in where
        ? `attachments/${where.featureId}/${id}`
        : `attachments/projects/${where.projectId}/${id}`;
    await storage().put(key, new TextEncoder().encode('file'), 'text/plain');
    await db.attachment.create({
      data: { id, ...where, source: 'FILE', title: 'notes.md', storageKey: key, addedById: pim.id },
    });
    return id;
  }

  /**
   * A Feature in the seeded Team with something in every table that hangs off it, owned by
   * a new PO (a Member, not an Admin). Returns the ids to check.
   */
  async function richFeature(projectTeamId: string = SEED.teamId) {
    const po = await member(`Po${Math.random().toString(36).slice(2, 7)}`);
    await db.teamMembership.create({ data: { teamId: projectTeamId, userId: po.id, role: 'PO' } });
    const team = await db.team.findUniqueOrThrow({ where: { id: projectTeamId } });
    const feature = await db.feature.create({
      data: {
        teamId: projectTeamId,
        title: 'Saved cards',
        roleOwners: {
          create: [
            { userId: po.id, role: 'PO' },
            { userId: beam.id, role: 'BACKEND' },
          ],
        },
      },
    });
    const featureId = feature.id;
    const platform = await db.platform.findFirstOrThrow({ where: { projectId: team.projectId } });
    await db.featurePlatform.create({ data: { featureId, platformId: platform.id } });
    const v1 = await db.specVersion.create({
      data: {
        featureId,
        version: 1,
        markdown: '# Saved cards\n',
        source: 'MANUAL',
        approvedById: po.id,
      },
    });
    const request = await db.decisionRequest.create({
      data: {
        featureId,
        kind: 'BLOCKER',
        raiserId: beam.id,
        title: 'Which vault?',
        description: 'We need one.',
        deciderRole: 'PO',
        status: 'OPEN',
        recipients: { create: { userId: po.id } },
        choices: {
          create: {
            position: 0,
            label: 'A',
            title: 'Ours',
            description: 'x',
            impactScope: 'x',
            impactTime: 'x',
            impactRisk: 'x',
          },
        },
        messages: { create: { authorId: beam.id, kind: 'NOTE', body: 'Soon please' } },
      },
      include: { choices: true },
    });
    const decided = await db.decisionRequest.create({
      data: {
        featureId,
        kind: 'QUESTION',
        raiserId: beam.id,
        deciderId: po.id,
        title: 'Card limit?',
        description: 'x',
        deciderRole: 'PO',
        status: 'DECIDED',
      },
    });
    const decision = await db.decision.create({
      data: { requestId: decided.id, decidedById: po.id, customAnswer: 'Five' },
    });
    const proposal = await db.specProposal.create({
      data: {
        featureId,
        baseVersionId: v1.id,
        source: 'DECISION',
        proposedMarkdown: '# Saved cards\nFive.\n',
        approverId: po.id,
        decisionId: decision.id,
      },
    });
    await db.redraft.create({
      data: {
        proposalKind: 'SPEC_PROPOSAL',
        proposalId: proposal.id,
        number: 1,
        content: {},
        specProposalId: proposal.id,
      },
    });
    await db.notification.create({
      data: { userId: beam.id, type: 'REQUEST_DECIDED', featureId, requestId: decided.id },
    });
    const now = new Date();
    await db.chatCard.createMany({
      data: [
        {
          userId: po.id,
          provider: 'LINE',
          event: 'DECISION_REQUEST',
          requestId: request.id,
          createdAt: now,
        },
        {
          userId: po.id,
          provider: 'LINE',
          event: 'SPEC_PROPOSAL',
          specProposalId: proposal.id,
          createdAt: now,
        },
      ],
    });
    const designDoc = await db.designDoc.create({
      data: { featureId, platformId: platform.id, template: 'BACK_END' },
    });
    await db.designDocVersion.create({
      data: {
        designDocId: designDoc.id,
        version: 1,
        markdown: '# API\n',
        source: 'AI_DRAFT',
        specVersionId: v1.id,
        approvedById: po.id,
      },
    });
    await db.designDocProposal.create({
      data: {
        designDocId: designDoc.id,
        reason: 'FIRST_DRAFT',
        specVersionId: v1.id,
        proposedMarkdown: '# API\n',
      },
    });
    const conversation = await db.conversation.create({
      data: { ownerId: po.id, projectId: team.projectId, featureId, title: 'Vaults' },
    });
    const message = await db.conversationMessage.create({
      data: { conversationId: conversation.id, position: 0, role: 'ASSISTANT', content: 'Here' },
    });
    await db.actionCard.create({
      data: {
        conversationId: conversation.id,
        messageId: message.id,
        toolCallId: 'call-1',
        kind: 'SPEC_PROPOSAL',
        targetId: proposal.id,
        title: 'Five cards',
      },
    });
    const suggestion = await db.featureSuggestion.create({
      data: {
        projectId: team.projectId,
        batchId: crypto.randomUUID(),
        title: 'Saved cards',
        rationale: 'x',
        businessValue: 'x',
        effort: 'LOW',
        risk: 'LOW',
        status: 'ACCEPTED',
        featureId,
        generatedById: pim.id,
      },
    });
    const receipt = await db.receipt.create({
      data: {
        task: 'generateChoices',
        taskKind: 'CHOICES',
        promptName: 'generate-choices',
        promptVersion: 'default@abc',
        latencyMs: 10,
        success: true,
        outputKind: 'CHOICES',
        outputId: request.id,
        proposalKind: 'CHOICES',
        proposalId: request.id,
        redraft: 1,
        projectId: team.projectId,
        outcomes: {
          create: {
            kind: 'APPROVE',
            proposalKind: 'CHOICES',
            proposalId: request.id,
            redraft: 1,
            choiceLabel: 'A',
          },
        },
      },
    });
    const file = await storedFile({ featureId });
    app.get(IndexingService).schedule({ source: 'SPEC_VERSION', id: v1.id });
    await testApp.drainIndexing();
    return {
      po,
      featureId,
      requestId: request.id,
      proposalId: proposal.id,
      suggestion,
      receipt,
      file,
      conversation,
    };
  }

  /** Counts every table under a Feature, by the Feature's id. */
  async function rowsOf(featureId: string) {
    const feature = { featureId };
    const request = { request: { featureId } };
    const counts = await Promise.all([
      db.feature.count({ where: { id: featureId } }),
      db.roleOwner.count({ where: feature }),
      db.featurePlatform.count({ where: feature }),
      db.specVersion.count({ where: feature }),
      db.specProposal.count({ where: feature }),
      db.decisionRequest.count({ where: feature }),
      db.decision.count({ where: request }),
      db.choice.count({ where: request }),
      db.requestRecipient.count({ where: request }),
      db.requestMessage.count({ where: request }),
      db.redraft.count({ where: { specProposal: feature } }),
      db.notification.count({ where: feature }),
      db.chatCard.count(), // only richFeature() makes any
      db.designDoc.count({ where: feature }),
      db.designDocVersion.count({ where: { designDoc: feature } }),
      db.designDocProposal.count({ where: { designDoc: feature } }),
      db.conversation.count({ where: feature }),
      db.actionCard.count({ where: { conversation: feature } }),
      db.attachment.count({ where: feature }),
      db.contentChunk.count({ where: feature }),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  }

  /** The events each of `users` hears while `run` runs. */
  async function heard(users: string[], run: () => Promise<unknown>) {
    const events = new Map<string, ServerEvent[]>(users.map((u) => [u, []]));
    const offs = users.map((u) => bus.subscribe(u, (e) => events.get(u)?.push(e)));
    try {
      await run();
    } finally {
      for (const off of offs) off();
    }
    return events;
  }

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'vorasaan-deletion-'));
    process.env.FILE_STORAGE_DRIVER = 'local';
    process.env.FILE_STORAGE_LOCAL_DIR = storageDir;
    testApp = await createTestApp();
    app = testApp.app;
    bus = app.get(EventBus);
    db = createTestPrisma();
  }, 60_000);

  afterAll(async () => {
    await testApp.designDocs.drain();
    await testApp.drainIndexing();
    await db.$disconnect();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seed(db);
    await rm(join(storageDir, 'attachments'), { recursive: true, force: true });
  });

  describe('DELETE /features/:id', () => {
    test("a PO deletes a Feature: its rows and stored files are gone, other Features' stay", async () => {
      const rich = await richFeature();
      const seededFile = await storedFile({ featureId: SEED.featureId });
      const projectFile = await storedFile({ projectId: SEED.projectId });
      expect(await rowsOf(rich.featureId)).toBeGreaterThan(20);

      const res = await as(app, rich.po.id)('DELETE', `/features/${rich.featureId}`);

      expect(res.status).toBe(204);
      expect(await rowsOf(rich.featureId)).toBe(0);
      expect(await filesUnder(rich.featureId)).toEqual([]);
      expect(await filesUnder(SEED.featureId)).toEqual([seededFile]);
      expect(await filesUnder(`projects/${SEED.projectId}`)).toEqual([projectFile]);
      // The seeded Feature and its Spec are untouched.
      expect(await db.specVersion.count({ where: { featureId: SEED.featureId } })).toBe(1);
      expect(await db.feature.count()).toBe(1);
    });

    test('Receipts, their outcomes and the accepted Feature Suggestion survive', async () => {
      const rich = await richFeature();

      await as(app, rich.po.id)('DELETE', `/features/${rich.featureId}`);

      const receipt = await db.receipt.findUniqueOrThrow({
        where: { id: rich.receipt.id },
        include: { outcomes: true },
      });
      expect(receipt.projectId).toBe(SEED.projectId);
      expect(receipt.outcomes).toHaveLength(1);
      const suggestion = await db.featureSuggestion.findUniqueOrThrow({
        where: { id: rich.suggestion.id },
      });
      expect(suggestion).toMatchObject({ status: 'ACCEPTED', featureId: null });
    });

    test('an Admin deletes any Feature of the Organization', async () => {
      const rich = await richFeature();
      const res = await as(app, pim.id)('DELETE', `/features/${rich.featureId}`);
      expect(res.status).toBe(204);
      expect(await db.feature.count({ where: { id: rich.featureId } })).toBe(0);
    });

    test('a non-PO Member gets 403 and nothing changes', async () => {
      const rich = await richFeature();
      const before = await rowsOf(rich.featureId);
      // Beam is a Role Owner (Backend) of it; a Team PO who is not its Role Owner can't either.
      const teamPo = await member('Tia');
      await db.teamMembership.create({
        data: { teamId: SEED.teamId, userId: teamPo.id, role: 'PO' },
      });

      for (const userId of [beam.id, teamPo.id]) {
        const res = await as(app, userId)<{ message: string }>(
          'DELETE',
          `/features/${rich.featureId}`,
        );
        expect(res.status).toBe(403);
      }

      expect(await rowsOf(rich.featureId)).toBe(before);
      expect(await filesUnder(rich.featureId)).toEqual([rich.file]);
    });

    test('an unknown Feature is a 404', async () => {
      const res = await as(app, pim.id)('DELETE', `/features/${crypto.randomUUID()}`);
      expect(res.status).toBe(404);
    });

    test('people with Inbox Items get inbox.changed; everyone in the Organization hears it went', async () => {
      const rich = await richFeature();
      const bystander = await member('Una');

      const events = await heard([rich.po.id, beam.id, bystander.id], () =>
        as(app, pim.id)('DELETE', `/features/${rich.featureId}`),
      );

      const names = (userId: string) => (events.get(userId) ?? []).map((e) => e.event).toSorted();
      // The PO had a Blocker and a Spec Proposal to act on; Beam raised the Blocker.
      expect(names(rich.po.id)).toEqual(['feature.deleted', 'inbox.changed']);
      expect(names(beam.id)).toEqual(['feature.deleted', 'inbox.changed']);
      expect(names(bystander.id)).toEqual(['feature.deleted']);
      expect(events.get(bystander.id)?.[0]).toEqual({
        event: 'feature.deleted',
        data: { featureId: rich.featureId, projectId: SEED.projectId, title: 'Saved cards' },
      });
    });

    test('background work queued for it ends quietly once it is gone', async () => {
      const rich = await richFeature();
      const version = await db.specVersion.findFirstOrThrow({
        where: { featureId: rich.featureId },
      });
      // Queued just before the delete: they then find nothing to work on.
      app.get(IndexingService).schedule({ source: 'SPEC_VERSION', id: version.id });
      testApp.designDocs.schedule(rich.featureId);

      const res = await as(app, rich.po.id)('DELETE', `/features/${rich.featureId}`);
      await testApp.drainIndexing();
      await testApp.designDocs.drain();

      expect(res.status).toBe(204);
      expect(await db.contentChunk.count({ where: { sourceId: version.id } })).toBe(0);
      expect(await db.designDoc.count({ where: { featureId: rich.featureId } })).toBe(0);
    });
  });

  describe('DELETE /projects/:id', () => {
    test('an Admin deletes a Project: every Feature and Project file under it is removed', async () => {
      const rich = await richFeature();
      const seededFile = await storedFile({ featureId: SEED.featureId });
      const projectFile = await storedFile({ projectId: SEED.projectId });
      // Another Project, whose files stay.
      const other = await db.project.create({
        data: { organizationId: SEED.organizationId, name: 'Wallet' },
      });
      const otherTeam = await db.team.create({ data: { projectId: other.id, name: 'Core' } });
      const otherFeature = await db.feature.create({
        data: { teamId: otherTeam.id, title: 'Top up' },
      });
      const otherFile = await storedFile({ featureId: otherFeature.id });
      const otherProjectFile = await storedFile({ projectId: other.id });
      const skill = await db.agentSkill.create({
        data: { organizationId: SEED.organizationId, name: 'diagrams', source: 'ZIP' },
      });
      await db.projectAgentSkill.create({ data: { projectId: SEED.projectId, skillId: skill.id } });

      const res = await as(app, pim.id)('DELETE', `/projects/${SEED.projectId}`);

      expect(res.status).toBe(204);
      expect(await filesUnder(rich.featureId)).toEqual([]);
      expect(await filesUnder(SEED.featureId)).toEqual([]);
      expect(await filesUnder(`projects/${SEED.projectId}`)).toEqual([]);
      expect(seededFile && projectFile).toBeTruthy();
      expect(await filesUnder(otherFeature.id)).toEqual([otherFile]);
      expect(await filesUnder(`projects/${other.id}`)).toEqual([otherProjectFile]);
      expect(await db.project.count({ where: { id: SEED.projectId } })).toBe(0);
      expect(await db.team.count({ where: { projectId: SEED.projectId } })).toBe(0);
      expect(await db.feature.findMany({ select: { id: true } })).toEqual([
        { id: otherFeature.id },
      ]);
      expect(await db.platform.count({ where: { projectId: SEED.projectId } })).toBe(0);
      expect(await db.featureSuggestion.count()).toBe(0);
      expect(await db.chatCard.count()).toBe(0);
      // The Organization's own records stay: the Skill (only its enablement goes), Receipts.
      expect(await db.agentSkill.count({ where: { id: skill.id } })).toBe(1);
      expect(await db.projectAgentSkill.count()).toBe(0);
      expect(await db.receipt.count({ where: { projectId: SEED.projectId } })).toBe(1);
      expect(await db.orgMembership.count()).toBeGreaterThan(2);
    });

    test('a Member gets 403 and nothing changes; an unknown Project is a 404', async () => {
      const file = await storedFile({ projectId: SEED.projectId });

      const res = await as(app, beam.id)('DELETE', `/projects/${SEED.projectId}`);
      const unknown = await as(app, pim.id)('DELETE', `/projects/${crypto.randomUUID()}`);

      expect(res.status).toBe(403);
      expect(unknown.status).toBe(404);
      expect(await db.project.count({ where: { id: SEED.projectId } })).toBe(1);
      expect(await filesUnder(`projects/${SEED.projectId}`)).toEqual([file]);
    });

    test('the Organization hears which Teams and Features went with it', async () => {
      const bystander = await member('Vee');
      const events = await heard([bystander.id, beam.id], () =>
        as(app, pim.id)('DELETE', `/projects/${SEED.projectId}`),
      );
      expect(events.get(bystander.id)).toEqual([
        {
          event: 'project.deleted',
          data: {
            projectId: SEED.projectId,
            name: 'Mobile Banking',
            teamIds: [SEED.teamId],
            featureIds: [SEED.featureId],
          },
        },
      ]);
      // Beam is in its Team.
      expect((events.get(beam.id) ?? []).map((e) => e.event).toSorted()).toEqual([
        'inbox.changed',
        'project.deleted',
      ]);
    });
  });
});
