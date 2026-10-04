import { Prisma, type PrismaClient, type TeamRole } from '@vorasaan/db';
import { SEED, SEED_PASSWORD, SEED_SPEC_V1, seed, seedFullTeam } from '@vorasaan/db/seed';
import type { RedraftContent } from '@vorasaan/shared';
import { SecretBox } from '../crypto/secret-box.ts';
import { escalationTimes } from '../response-windows/escalation.job.ts';
import { addWorkingTime, MINUTE, type WorkingCalendar } from '../response-windows/working-time.ts';
import { chunkMarkdown, type TextChunk } from '../retrieval/chunker.ts';
import { hnswIndexSql, toVectorLiteral } from '../retrieval/content-chunk.repository.ts';
import { fakeEmbedding } from '../retrieval/fake-embedding.port.ts';
import { HANDBOOK, TOPICS } from '../retrieval/large-project.fixture.ts';
import { decisionText } from '../retrieval/source-text.ts';
import { SeededRandom } from './random.ts';

/**
 * The large Organization of the performance baseline (ticket 0073): many Projects,
 * Features, Decision Requests in every state (with Choices, Redrafts, Claims, NEEDS_INFO
 * spells, Delegations and escalation steps) and content chunks with embeddings, built
 * from a fixed seed so every run measures the same data.
 *
 * It sits on top of the tracer-bullet seed (`seed()` and `seedFullTeam()`): Pim, the Admin,
 * is a PO in every Team and a Role Owner of every Feature, so her Inbox is the heaviest one,
 * and "Async checkout" (SEED.featureId) carries the large-project fixture's handbook, so a
 * retrieval run can check the needle is still found.
 */

export type LargeOrgScale = {
  projects: number;
  featuresPerProject: number;
  requestsPerFeature: number;
  /** Content chunks in all, from every source; Feature Attachments fill what the rest leaves. */
  chunks: number;
  users: number;
};

export const LARGE_ORG_SCALES = {
  /** For the seed's own test: every state, a few of each. */
  small: { projects: 2, featuresPerProject: 3, requestsPerFeature: 12, chunks: 600, users: 16 },
  /** For the non-blocking CI job: a tenth of `large`. */
  medium: {
    projects: 5,
    featuresPerProject: 10,
    requestsPerFeature: 40,
    chunks: 20_000,
    users: 40,
  },
  /** The baseline: 50 Projects, 500 Features, 20,000 Decision Requests, 200,000 chunks. */
  large: {
    projects: 50,
    featuresPerProject: 10,
    requestsPerFeature: 40,
    chunks: 200_000,
    users: 200,
  },
} as const satisfies Record<string, LargeOrgScale>;

export type LargeOrgScaleName = keyof typeof LARGE_ORG_SCALES;

/** The default seed: the same number always builds the same Organization. */
export const LARGE_ORG_SEED = 73;

/**
 * "Now" for the data: a Monday at 10:00 UTC, inside the default working hours. Every
 * timestamp is placed relative to it, and the benchmark sets the app's clock to it.
 */
export const LARGE_ORG_NOW = new Date('2026-06-01T10:00:00.000Z');

/** The embeddings the chunks carry: FakeEmbeddingPort's vectors under this model name. */
export const LARGE_ORG_EMBEDDINGS = {
  baseUrl: 'https://embeddings.bench.invalid/v1',
  model: 'bench-embedding',
  dims: 256,
} as const;

/** The default Organization calendar (UTC, Monday to Friday 09:00-18:00, no holidays). */
const CALENDAR: WorkingCalendar = {
  timeZone: 'UTC',
  workingDays: new Set([1, 2, 3, 4, 5]),
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  holidays: new Set(),
};
/** The default windows: a Blocker 4 working hours, a Question 2 working days. */
const WINDOW_MINUTES = { BLOCKER: 4 * 60, QUESTION: 2 * 9 * 60 } as const;

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const STATUS_WEIGHTS = {
  DRAFT: 5,
  OPEN: 20,
  NEEDS_INFO: 5,
  DECIDED: 35,
  SPEC_UPDATED: 25,
  WITHDRAWN: 10,
} as const;
type Status = keyof typeof STATUS_WEIGHTS;
const STATUSES = Object.keys(STATUS_WEIGHTS) as Status[];

const RAISER_ROLES: TeamRole[] = ['BACKEND', 'FRONTEND', 'MOBILE', 'QA', 'DESIGNER'];
const ROLES: TeamRole[] = ['PO', 'DESIGNER', 'TECH_LEAD', 'BACKEND', 'FRONTEND', 'MOBILE', 'QA'];

/** Sections of generated documents are cut to one chunk each: more than half a chunk, less than one. */
const SECTION_MIN_CHARS = 1_000;
const SECTION_MAX_CHARS = 1_450;
const SECTIONS_PER_DOCUMENT = 32;
const PROJECT_ATTACHMENT_SECTIONS = 8;

export type LargeOrgCounts = {
  users: number;
  projects: number;
  teams: number;
  features: number;
  roleOwners: number;
  delegations: number;
  decisionRequests: number;
  requestsByStatus: Record<Status, number>;
  recipients: number;
  choices: number;
  redrafts: number;
  deciderChanges: number;
  requestMessages: number;
  historyEntries: number;
  decisions: number;
  specVersions: number;
  specProposals: number;
  briefVersions: number;
  attachments: number;
  notifications: number;
  chunks: number;
};

export type LargeOrgResult = { scale: LargeOrgScale; seed: number; counts: LargeOrgCounts };

type Person = { id: string; name: string };
type Roster = Record<TeamRole, string[]>;

type TeamPlan = {
  id: string;
  projectId: string;
  index: number;
  roster: Roster;
  /** Role Owners of each of its Features: the roster, except the second Tech Lead. */
  owners: Roster;
  /** The first Tech Lead's Delegate (the second one), and when. */
  delegations: { from: Date; to: Date }[];
};

/**
 * Builds the large Organization into an empty database (truncate it first) and returns
 * the counts it wrote. `VORASAAN_SECRET_KEY` must be set: the embeddings key is encrypted.
 */
export async function seedLargeOrganization(
  db: PrismaClient,
  options: { scale: LargeOrgScale; seed?: number; log?: (line: string) => void },
): Promise<LargeOrgResult> {
  const { scale } = options;
  const seedValue = options.seed ?? LARGE_ORG_SEED;
  const log = options.log ?? (() => {});
  const random = new SeededRandom(seedValue);
  const writer = new Writer(db);
  const t0 = performance.now();

  await seed(db);
  await seedFullTeam(db);
  const organizationId = SEED.organizationId;

  // ── People ─────────────────────────────────────────────────────────────────
  const passwordHash = await Bun.password.hash(SEED_PASSWORD, { algorithm: 'argon2id' });
  const seeded = Object.values(SEED.users).map((u) => ({ id: u.id, name: u.name }));
  const pool: Person[] = Array.from(
    { length: Math.max(0, scale.users - seeded.length) },
    (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return { id: random.uuid(), name: `Bench Person ${n}` };
    },
  );
  await db.user.createMany({
    data: pool.map((p, i) => ({
      id: p.id,
      name: p.name,
      email: `bench-${String(i + 1).padStart(3, '0')}@bench.test`,
      passwordHash,
    })),
  });
  await db.orgMembership.createMany({
    data: pool.map((p) => ({ organizationId, userId: p.id })),
  });
  const names = new Map([...seeded, ...pool].map((p) => [p.id, p.name]));
  const people = (ids: string[]) =>
    [...new Set(ids)]
      .map((id) => ({ id, name: names.get(id) ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  let poolCursor = 0;
  const nextPooled = () => {
    const person = pool[poolCursor++ % Math.max(1, pool.length)];
    if (!person) throw new Error('The large Organization needs more than the seeded users');
    return person.id;
  };

  // The embeddings provider, so retrieval ranks by vector like a configured install.
  await db.orgIntegration.create({
    data: {
      organizationId,
      provider: 'EMBEDDINGS',
      baseUrl: LARGE_ORG_EMBEDDINGS.baseUrl,
      model: LARGE_ORG_EMBEDDINGS.model,
      secretEncrypted: SecretBox.fromEnv().encrypt('bench-embeddings-key'),
    },
  });

  // ── Projects, Teams, Features ─────────────────────────────────────────────
  const { pim, beam, mint, fern, oak } = SEED.users;
  const vocabulary = makeVocabulary(random, 4_000);
  const teams: TeamPlan[] = [];
  const features: { id: string; title: string; team: TeamPlan; themes: string[] }[] = [];

  for (let p = 0; p < scale.projects; p++) {
    const first = p === 0;
    const projectId = first ? SEED.projectId : random.uuid();
    const teamId = first ? SEED.teamId : random.uuid();
    if (!first) {
      await db.project.create({
        data: {
          id: projectId,
          organizationId,
          name: `Bench Project ${String(p + 1).padStart(2, '0')}`,
          jiraKey: `B${p + 1}`,
          createdAt: new Date(LARGE_ORG_NOW.getTime() - 120 * DAY),
        },
      });
      await db.team.create({
        data: { id: teamId, projectId, name: `Team ${p + 1}` },
      });
    }
    const roster: Roster = first
      ? {
          PO: [pim.id, mint.id],
          DESIGNER: [fern.id],
          TECH_LEAD: [oak.id, nextPooled()],
          BACKEND: [beam.id, nextPooled()],
          FRONTEND: [nextPooled()],
          MOBILE: [nextPooled()],
          QA: [nextPooled()],
        }
      : {
          PO: [pim.id, nextPooled()],
          DESIGNER: [nextPooled()],
          TECH_LEAD: [nextPooled(), nextPooled()],
          BACKEND: [nextPooled(), nextPooled()],
          FRONTEND: [nextPooled()],
          MOBILE: [nextPooled()],
          QA: [nextPooled()],
        };
    for (const role of ROLES) roster[role] = [...new Set(roster[role])];
    const owners: Roster = { ...roster, TECH_LEAD: roster.TECH_LEAD.slice(0, 1) };
    const delegations = [
      { from: offset(-30 * DAY), to: offset(-20 * DAY) },
      ...(p % 2 === 0 ? [{ from: offset(-3 * DAY), to: offset(4 * DAY) }] : []),
    ];
    const team: TeamPlan = { id: teamId, projectId, index: p, roster, owners, delegations };
    teams.push(team);

    await db.teamMembership.createMany({
      data: ROLES.flatMap((role) => roster[role].map((userId) => ({ teamId, userId, role }))),
      skipDuplicates: true,
    });
    const [lead, delegate] = roster.TECH_LEAD;
    if (lead && delegate && lead !== delegate) {
      await db.delegation.createMany({
        data: delegations.map((d) => ({
          id: random.uuid(),
          teamId,
          role: 'TECH_LEAD' as const,
          delegatorId: lead,
          delegateId: delegate,
          startsAt: d.from,
          endsAt: d.to,
          createdById: lead,
          createdAt: new Date(d.from.getTime() - DAY),
        })),
      });
    } else {
      team.delegations = [];
    }

    for (let f = 0; f < scale.featuresPerProject; f++) {
      const seedFeature = first && f === 0;
      const id = seedFeature ? SEED.featureId : random.uuid();
      const title = seedFeature ? 'Async checkout' : `${random.pick(TOPICS)[0]} ${p + 1}.${f + 1}`;
      if (!seedFeature) {
        await db.feature.create({
          data: {
            id,
            teamId,
            title,
            description: `Bench Feature ${f + 1} of project ${p + 1}.`,
            status: random.pick(['DRAFT', 'IN_PROGRESS', 'IN_PROGRESS', 'DONE'] as const),
            createdAt: offset(-100 * DAY),
          },
        });
      }
      await db.roleOwner.createMany({
        data: ROLES.flatMap((role) =>
          owners[role].map((userId) => ({ featureId: id, userId, role })),
        ),
        skipDuplicates: true,
      });
      const themes = Array.from({ length: 12 }, () => random.pick(vocabulary));
      features.push({ id, title, team, themes });
    }
  }
  log(`  people, ${teams.length} Projects and ${features.length} Features`);

  // ── Decision Requests, Decisions, Spec Versions ──────────────────────────
  const seedSpec = await db.specVersion.findUniqueOrThrow({
    where: { featureId_version: { featureId: SEED.featureId, version: 1 } },
    select: { id: true },
  });
  const chunkPlans: ChunkPlan[] = [];
  for (const [i, feature] of features.entries()) {
    const plan = planFeatureRequests(
      random,
      feature,
      scale.requestsPerFeature,
      people,
      vocabulary,
      seedSpec.id,
    );
    writer.add(plan.rows);
    chunkPlans.push(...plan.chunks);
    await writer.flushIfLarge();
    if ((i + 1) % 50 === 0) log(`  Decision Requests: ${i + 1}/${features.length} Features`);
  }
  await writer.flush();
  log(`  Decision Requests written (${Math.round(performance.now() - t0)} ms)`);

  // ── Project Briefs and Attachments ────────────────────────────────────────
  for (const team of teams) {
    const briefId = random.uuid();
    const markdown = briefMarkdown(team.index);
    await db.briefVersion.create({
      data: {
        id: briefId,
        projectId: team.projectId,
        version: 1,
        markdown,
        source: 'MANUAL',
        approvedById: pim.id,
        createdAt: offset(-110 * DAY),
      },
    });
    chunkPlans.push({
      source: 'BRIEF_VERSION',
      sourceId: briefId,
      projectId: team.projectId,
      featureId: null,
      chunks: chunkMarkdown(markdown),
    });
    const attachmentId = random.uuid();
    const doc = generatedDocument(
      random,
      `Project ${team.index + 1} handbook`,
      PROJECT_ATTACHMENT_SECTIONS,
      vocabulary,
      [],
    );
    await db.attachment.create({
      data: {
        id: attachmentId,
        projectId: team.projectId,
        source: 'FILE',
        title: `Project ${team.index + 1} handbook`,
        snapshotText: doc.text,
        snapshotAt: offset(-105 * DAY),
        addedById: pim.id,
        createdAt: offset(-105 * DAY),
      },
    });
    chunkPlans.push({
      source: 'ATTACHMENT',
      sourceId: attachmentId,
      projectId: team.projectId,
      featureId: null,
      chunks: doc.chunks,
    });
  }

  // Feature Attachments fill the chunks the rest leaves, evenly across Features.
  const fixed = chunkPlans.reduce((n, plan) => n + plan.chunks.length, 0);
  const left = scale.chunks - fixed;
  if (left < features.length) {
    throw new Error(
      `${scale.chunks} chunks are too few for this scale: Specs, Decisions and Briefs already take ${fixed}`,
    );
  }
  const share = Math.floor(left / features.length);
  const sink = new ChunkSink(db, random, organizationId, log);
  for (const plan of chunkPlans) await sink.add(plan);
  for (const [i, feature] of features.entries()) {
    let want = share + (i < left % features.length ? 1 : 0);
    const attachments: { id: string; title: string; text: string; chunks: TextChunk[] }[] = [];
    if (feature.id === SEED.featureId) {
      const chunks = chunkMarkdown(HANDBOOK);
      if (chunks.length <= want) {
        attachments.push({
          id: random.uuid(),
          title: 'Payments operations handbook',
          text: HANDBOOK,
          chunks,
        });
        want -= chunks.length;
      }
    }
    for (let n = 1; want > 0; n++) {
      const sections = Math.min(SECTIONS_PER_DOCUMENT, want);
      const title = `${feature.title} notes ${n}`;
      const doc = generatedDocument(random, title, sections, vocabulary, feature.themes);
      attachments.push({ id: random.uuid(), title, ...doc });
      want -= sections;
    }
    await db.attachment.createMany({
      data: attachments.map((a, n) => ({
        id: a.id,
        featureId: feature.id,
        source: 'FILE' as const,
        title: a.title,
        mimeType: 'text/markdown',
        snapshotText: a.text,
        snapshotAt: offset(-90 * DAY + n * HOUR),
        addedById: pim.id,
        createdAt: offset(-90 * DAY + n * HOUR),
      })),
    });
    for (const a of attachments) {
      await sink.add({
        source: 'ATTACHMENT',
        sourceId: a.id,
        projectId: feature.team.projectId,
        featureId: feature.id,
        chunks: a.chunks,
      });
    }
  }
  await sink.finish();
  log(
    `  Attachments and ${sink.written} chunks written (${Math.round(performance.now() - t0)} ms)`,
  );

  // ── The HNSW index, built once after the bulk load ───────────────────────
  await db.$executeRawUnsafe(hnswIndexSql(LARGE_ORG_EMBEDDINGS.dims));
  await db.$executeRawUnsafe('ANALYZE');
  log(`  HNSW index built (${Math.round(performance.now() - t0)} ms)`);

  return { scale, seed: seedValue, counts: await countLargeOrganization(db) };
}

/** What the database holds now, in the terms of LargeOrgCounts. */
export async function countLargeOrganization(db: PrismaClient): Promise<LargeOrgCounts> {
  const byStatus = await db.decisionRequest.groupBy({ by: ['status'], _count: true });
  const requestsByStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
    Status,
    number
  >;
  for (const row of byStatus) requestsByStatus[row.status] = row._count;
  const [chunks] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ContentChunk"`;
  return {
    users: await db.user.count(),
    projects: await db.project.count(),
    teams: await db.team.count(),
    features: await db.feature.count(),
    roleOwners: await db.roleOwner.count(),
    delegations: await db.delegation.count(),
    decisionRequests: await db.decisionRequest.count(),
    requestsByStatus,
    recipients: await db.requestRecipient.count(),
    choices: await db.choice.count(),
    redrafts: await db.redraft.count(),
    deciderChanges: await db.deciderChange.count(),
    requestMessages: await db.requestMessage.count(),
    historyEntries: await db.requestHistoryEntry.count(),
    decisions: await db.decision.count(),
    specVersions: await db.specVersion.count(),
    specProposals: await db.specProposal.count(),
    briefVersions: await db.briefVersion.count(),
    attachments: await db.attachment.count(),
    notifications: await db.notification.count(),
    chunks: Number(chunks?.n ?? 0),
  };
}

/**
 * A digest of the seeded rows that come from the random source (ids, states, times,
 * texts and vectors), to show the same seed builds the same Organization.
 */
export async function fingerprintLargeOrganization(db: PrismaClient): Promise<string> {
  const [row] = await db.$queryRaw<{ digest: string }[]>`
    SELECT md5(concat_ws('|',
      (SELECT md5(string_agg(concat_ws(',', id, status, kind, "deciderId", "submittedAt",
               "dueAt", "escalationStep"), ';' ORDER BY id)) FROM "DecisionRequest"),
      (SELECT md5(string_agg(concat_ws(',', id, "requestId", "choiceId", "createdAt"), ';'
               ORDER BY id)) FROM "Decision"),
      (SELECT md5(string_agg(concat_ws(',', "featureId", version, md5(markdown)), ';'
               ORDER BY "featureId", version)) FROM "SpecVersion"),
      (SELECT md5(string_agg(concat_ws(',', id, source, position, md5(text),
               md5(embedding::text)), ';' ORDER BY id)) FROM "ContentChunk")
    )) AS digest`;
  return row?.digest ?? '';
}

// ─── Decision Requests of one Feature ───────────────────────────────────────

type ChunkPlan = {
  source: 'ATTACHMENT' | 'SPEC_VERSION' | 'DECISION' | 'BRIEF_VERSION';
  sourceId: string;
  projectId: string;
  featureId: string | null;
  chunks: TextChunk[];
};

type Rows = {
  decisionRequest: Prisma.DecisionRequestCreateManyInput[];
  requestRecipient: Prisma.RequestRecipientCreateManyInput[];
  choice: Prisma.ChoiceCreateManyInput[];
  redraft: Prisma.RedraftCreateManyInput[];
  deciderChange: Prisma.DeciderChangeCreateManyInput[];
  requestMessage: Prisma.RequestMessageCreateManyInput[];
  requestHistoryEntry: Prisma.RequestHistoryEntryCreateManyInput[];
  decision: Prisma.DecisionCreateManyInput[];
  specProposal: Prisma.SpecProposalCreateManyInput[];
  specVersion: Prisma.SpecVersionCreateManyInput[];
  notification: Prisma.NotificationCreateManyInput[];
};

const emptyRows = (): Rows => ({
  decisionRequest: [],
  requestRecipient: [],
  choice: [],
  redraft: [],
  deciderChange: [],
  requestMessage: [],
  requestHistoryEntry: [],
  decision: [],
  specProposal: [],
  specVersion: [],
  notification: [],
});

function planFeatureRequests(
  random: SeededRandom,
  feature: { id: string; title: string; team: TeamPlan },
  count: number,
  people: (ids: string[]) => Person[],
  vocabulary: string[],
  /** The seeded Feature's v1, written by `seed()`. */
  seedSpecId: string,
): { rows: Rows; chunks: ChunkPlan[] } {
  const rows = emptyRows();
  const chunks: ChunkPlan[] = [];
  const { team } = feature;
  const now = LARGE_ORG_NOW.getTime();
  const clamp = (t: number) => new Date(Math.min(t, now - MINUTE));
  const approvals: { at: Date; proposalId: string; approverId: string; title: string }[] = [];
  const pendingProposals: Prisma.SpecProposalCreateManyInput[] = [];

  for (let i = 0; i < count; i++) {
    // The first six cycle through every state, so even a small Feature has each one.
    const status: Status =
      i < STATUSES.length ? (STATUSES[i] as Status) : random.weighted(STATUS_WEIGHTS);
    const id = random.uuid();
    const kind = random.chance(0.3) ? ('BLOCKER' as const) : ('QUESTION' as const);
    const withChoices = random.chance(0.8);
    const raiserRole = random.pick(RAISER_ROLES);
    const raiserId = random.pick(team.owners[raiserRole]);
    let deciderRole = random.weighted({ PO: 2, TECH_LEAD: 1, DESIGNER: 1 }) as TeamRole;
    if (deciderRole === raiserRole) deciderRole = 'PO';

    const recent = status === 'OPEN' || status === 'NEEDS_INFO' || status === 'DRAFT';
    const createdAt = new Date(
      now -
        (recent
          ? random.int(1, 10 * 24) * HOUR
          : random.int(1, 84) * DAY + random.int(0, 23) * HOUR),
    );
    const submittedAt = status === 'DRAFT' ? null : new Date(createdAt.getTime() + 5 * MINUTE);
    const windowMinutes = WINDOW_MINUTES[kind];
    const dueAt = submittedAt
      ? addWorkingTime(submittedAt, windowMinutes * MINUTE, CALENDAR)
      : null;

    // Recipients, resolved through the Delegation active when it was sent.
    let recipients: { userId: string; onBehalfOfId: string | null }[] = [];
    if (submittedAt) {
      const [lead, delegate] = team.roster.TECH_LEAD;
      const delegated =
        deciderRole === 'TECH_LEAD' &&
        lead &&
        delegate &&
        delegate !== raiserId &&
        team.delegations.some((d) => d.from <= submittedAt && submittedAt < d.to);
      recipients = delegated
        ? [{ userId: delegate, onBehalfOfId: lead }]
        : team.owners[deciderRole]
            .filter((userId) => userId !== raiserId)
            .map((userId) => ({ userId, onBehalfOfId: null }));
      if (!recipients.length) {
        deciderRole = 'PO';
        recipients = team.owners.PO.filter((u) => u !== raiserId).map((userId) => ({
          userId,
          onBehalfOfId: null,
        }));
      }
    }
    const recipientIds = recipients.map((r) => r.userId);

    // The Decider: set at send when it went to one person, else by a Claim (or nobody yet).
    let deciderId: string | null = null;
    const claimAt = submittedAt ? clamp(submittedAt.getTime() + random.int(5, 240) * MINUTE) : null;
    if (submittedAt && status !== 'WITHDRAWN') {
      if (recipients.length === 1) deciderId = recipientIds[0] ?? null;
      else if (status !== 'OPEN' || random.chance(0.5)) {
        deciderId = random.pick(recipientIds);
        rows.deciderChange.push({
          id: random.uuid(),
          requestId: id,
          deciderId,
          kind: 'CLAIMED',
          createdAt: claimAt ?? submittedAt,
        });
      }
    }

    const title = `${kind === 'BLOCKER' ? 'Blocked on' : 'Which'} ${phrase(random, vocabulary, 4)} for ${feature.title}?`;
    const description = `${sentence(random, vocabulary)} ${sentence(random, vocabulary)}`;
    const request: Prisma.DecisionRequestCreateManyInput = {
      id,
      featureId: feature.id,
      kind,
      withChoices,
      raiserId,
      title,
      description,
      suggestedRole: deciderRole,
      deciderRole,
      deciderId,
      status,
      submittedAt,
      responseWindowMinutes: submittedAt ? windowMinutes : null,
      dueAt,
      createdAt,
      updatedAt: createdAt,
    };
    rows.decisionRequest.push(request);
    for (const r of recipients)
      rows.requestRecipient.push({ id: random.uuid(), requestId: id, ...r });

    // Choices, and a Request changes on them for one request in ten.
    const choices = withChoices
      ? ['A', 'B', 'C'].map((label, position) => ({
          id: random.uuid(),
          requestId: id,
          position,
          label,
          title: phrase(random, vocabulary, 3),
          description: sentence(random, vocabulary),
          impactScope: phrase(random, vocabulary, 3),
          impactTime: `${random.int(1, 10)} days`,
          impactRisk: random.pick(['Low', 'Medium', 'High']),
        }))
      : [];
    rows.choice.push(...choices);
    if (withChoices && random.chance(0.1)) {
      const content = (list: typeof choices): RedraftContent => ({
        kind: 'CHOICES',
        choices: list.map(({ label, title, description, impactScope, impactTime, impactRisk }) => ({
          label,
          title,
          description,
          impactScope,
          impactTime,
          impactRisk,
        })),
      });
      const first = choices.map((c) => ({ ...c, title: phrase(random, vocabulary, 3) }));
      rows.redraft.push(
        {
          id: random.uuid(),
          proposalKind: 'CHOICES',
          proposalId: id,
          requestId: id,
          number: 1,
          content: content(first),
          createdAt,
          readyAt: createdAt,
        },
        {
          id: random.uuid(),
          proposalKind: 'CHOICES',
          proposalId: id,
          requestId: id,
          number: 2,
          content: content(choices),
          feedback: `Make the choices about ${phrase(random, vocabulary, 2)}.`,
          requestedById: raiserId,
          summary: 'Reworded the Choices.',
          createdAt: new Date(createdAt.getTime() + 2 * MINUTE),
          readyAt: new Date(createdAt.getTime() + 3 * MINUTE),
        },
      );
    }

    if (!submittedAt) continue;

    if (status === 'OPEN' && dueAt && dueAt.getTime() <= now) {
      // Escalation: most overdue requests are as far as they should be; some still owe steps.
      const times = escalationTimes(dueAt, windowMinutes * MINUTE, CALENDAR);
      const target = times.filter((t) => t.getTime() <= now).length;
      const step = random.chance(0.3) ? random.int(0, Math.max(0, target - 1)) : target;
      request.escalationStep = step;
      const waitingOn = deciderId ? [deciderId] : recipientIds;
      for (let s = 1; s <= step; s++) {
        const at = times[s - 1] ?? LARGE_ORG_NOW;
        let to: string[] = [];
        if (s === 1) to = waitingOn;
        else if (s === 2) {
          const [lead, delegate] = team.roster.TECH_LEAD;
          const active = team.delegations.some((d) => d.from <= at && at < d.to);
          if (
            active &&
            lead &&
            delegate &&
            recipientIds.includes(lead) &&
            !recipientIds.includes(delegate) &&
            delegate !== raiserId
          ) {
            to = [delegate];
            rows.requestRecipient.push({
              id: random.uuid(),
              requestId: id,
              userId: delegate,
              onBehalfOfId: lead,
            });
          }
        } else to = [raiserId, ...team.roster.TECH_LEAD];
        const kindOf = (['REMINDED', 'DELEGATES_ADDED', 'OVERDUE_REPORTED'] as const)[s - 1];
        const type = (['REQUEST_REMINDER', 'REQUEST_ESCALATED', 'REQUEST_OVERDUE'] as const)[s - 1];
        if (!kindOf || !type) continue;
        rows.requestHistoryEntry.push({
          id: random.uuid(),
          requestId: id,
          kind: kindOf,
          people: people(to),
          createdAt: at,
        });
        for (const userId of new Set(to)) {
          rows.notification.push({
            id: random.uuid(),
            userId,
            type,
            featureId: feature.id,
            requestId: id,
            readAt: random.chance(0.5) ? at : null,
            createdAt: at,
          });
        }
      }
      continue;
    }

    if (status === 'OPEN') continue;

    if (status === 'WITHDRAWN') {
      request.closedAt = clamp(submittedAt.getTime() + random.int(1, 72) * HOUR);
      continue;
    }

    const asker = deciderId ?? recipientIds[0] ?? raiserId;
    if (status === 'NEEDS_INFO') {
      const askedAt = clamp((claimAt ?? submittedAt).getTime() + random.int(10, 600) * MINUTE);
      request.pausedAt = askedAt;
      request.updatedAt = askedAt;
      rows.requestMessage.push({
        id: random.uuid(),
        requestId: id,
        authorId: asker,
        kind: 'QUESTION',
        body: `Can you say more about ${phrase(random, vocabulary, 3)}?`,
        createdAt: askedAt,
      });
      continue;
    }

    // DECIDED or SPEC_UPDATED: a Decision, sometimes after a NEEDS_INFO spell.
    const decidedAt = clamp(submittedAt.getTime() + random.int(10, 6 * 24 * 60) * MINUTE);
    const span = decidedAt.getTime() - submittedAt.getTime();
    if (random.chance(0.25) && span > 10 * MINUTE) {
      rows.requestMessage.push(
        {
          id: random.uuid(),
          requestId: id,
          authorId: asker,
          kind: 'QUESTION',
          body: `What about ${phrase(random, vocabulary, 3)}?`,
          createdAt: new Date(submittedAt.getTime() + span * 0.3),
        },
        {
          id: random.uuid(),
          requestId: id,
          authorId: raiserId,
          kind: 'ANSWER',
          body: sentence(random, vocabulary),
          createdAt: new Date(submittedAt.getTime() + span * 0.6),
        },
      );
    }
    const choice = choices.length && random.chance(0.85) ? random.pick(choices) : null;
    const rationale = random.chance(0.5) ? sentence(random, vocabulary) : null;
    const customAnswer = choice ? null : sentence(random, vocabulary);
    const decisionId = random.uuid();
    const onBehalfOfId = recipients.find((r) => r.userId === asker)?.onBehalfOfId ?? null;
    rows.decision.push({
      id: decisionId,
      requestId: id,
      decidedById: asker,
      onBehalfOfId,
      choiceId: choice?.id ?? null,
      customAnswer,
      rationale,
      source: random.weighted({ WEB: 70, CLI: 15, LINE: 5, SLACK: 5, TEAMS: 5 }),
      createdAt: decidedAt,
    });
    request.updatedAt = decidedAt;
    rows.notification.push({
      id: random.uuid(),
      userId: raiserId,
      type: 'REQUEST_DECIDED',
      featureId: feature.id,
      requestId: id,
      readAt: random.chance(0.8) ? decidedAt : null,
      createdAt: decidedAt,
    });
    chunks.push({
      source: 'DECISION',
      sourceId: decisionId,
      projectId: team.projectId,
      featureId: feature.id,
      chunks: chunkMarkdown(
        decisionText({
          customAnswer,
          rationale,
          choice: choice
            ? { label: choice.label, title: choice.title, description: choice.description }
            : null,
          request: { title, description },
        }),
      ),
    });

    const proposalId = random.uuid();
    if (status === 'SPEC_UPDATED') {
      const approvedAt = clamp(decidedAt.getTime() + random.int(30, 48 * 60) * MINUTE);
      request.closedAt = approvedAt;
      request.updatedAt = approvedAt;
      approvals.push({ at: approvedAt, proposalId, approverId: asker, title });
      rows.specProposal.push({
        id: proposalId,
        featureId: feature.id,
        source: 'DECISION',
        proposedMarkdown: '',
        status: 'APPROVED',
        approverId: asker,
        decisionId,
        reviewedAt: approvedAt,
        createdAt: new Date(decidedAt.getTime() + MINUTE),
      });
    } else if (random.chance(0.6)) {
      // DECIDED with its Spec Proposal still waiting: an Inbox Item for the Decider.
      pendingProposals.push({
        id: proposalId,
        featureId: feature.id,
        source: 'DECISION',
        proposedMarkdown: '',
        status: 'PENDING',
        approverId: asker,
        decisionId,
        createdAt: new Date(decidedAt.getTime() + MINUTE),
      });
    }
  }

  // Spec Versions: v1, then one per approved Spec Proposal in the order they were approved.
  approvals.sort((a, b) => a.at.getTime() - b.at.getTime());
  const isSeedFeature = feature.id === SEED.featureId;
  const decided: string[] = [];
  const versions: Prisma.SpecVersionCreateManyInput[] = [];
  let markdown = isSeedFeature ? SEED_SPEC_V1 : specMarkdown(feature.title, decided);
  let latestId: string | null = isSeedFeature ? seedSpecId : null;
  if (!isSeedFeature) {
    latestId = random.uuid();
    versions.push({
      id: latestId,
      featureId: feature.id,
      version: 1,
      markdown,
      source: 'MANUAL',
      summary: 'Initial Spec',
      approvedById: SEED.users.pim.id,
      createdAt: new Date(now - 95 * DAY),
    });
  }
  const proposals = new Map(rows.specProposal.map((p) => [p.id, p]));
  for (const [n, approval] of approvals.entries()) {
    decided.push(approval.title);
    const proposal = proposals.get(approval.proposalId);
    const base = latestId;
    markdown = specMarkdown(feature.title, decided);
    latestId = random.uuid();
    if (proposal) {
      proposal.proposedMarkdown = markdown;
      proposal.baseVersionId = base;
    }
    versions.push({
      id: latestId,
      featureId: feature.id,
      version: n + 2,
      markdown,
      source: 'DECISION',
      summary: `Decided: ${approval.title}`,
      approvedById: approval.approverId,
      proposalId: approval.proposalId,
      createdAt: approval.at,
    });
  }
  for (const pending of pendingProposals) {
    pending.baseVersionId = latestId;
    pending.proposedMarkdown = `${markdown}\n- (proposed) ${pending.id}\n`;
  }
  rows.specProposal.push(...pendingProposals);
  rows.specVersion.push(...versions);
  // Only the latest Spec Version is indexed.
  if (latestId) {
    chunks.push({
      source: 'SPEC_VERSION',
      sourceId: latestId,
      projectId: team.projectId,
      featureId: feature.id,
      chunks: chunkMarkdown(markdown),
    });
  }
  return { rows, chunks };
}

// ─── Writing ────────────────────────────────────────────────────────────────

/** Buffers rows and writes them in FK order with createMany, a few thousand at a time. */
class Writer {
  private rows = emptyRows();
  private size = 0;

  constructor(private readonly db: PrismaClient) {}

  add(rows: Rows) {
    for (const key of Object.keys(rows) as (keyof Rows)[]) {
      (this.rows[key] as unknown[]).push(...rows[key]);
      this.size += rows[key].length;
    }
  }

  async flushIfLarge() {
    if (this.size >= 20_000) await this.flush();
  }

  async flush() {
    const r = this.rows;
    this.rows = emptyRows();
    this.size = 0;
    const db = this.db;
    // Spec Proposals point at Decisions and base Spec Versions, and Spec Versions at
    // their proposal: write proposals without a base first, then versions, then the rest.
    await batched(r.decisionRequest, (data) => db.decisionRequest.createMany({ data }));
    await batched(r.requestRecipient, (data) => db.requestRecipient.createMany({ data }));
    await batched(r.choice, (data) => db.choice.createMany({ data }));
    await batched(r.redraft, (data) => db.redraft.createMany({ data }));
    await batched(r.deciderChange, (data) => db.deciderChange.createMany({ data }));
    await batched(r.requestMessage, (data) => db.requestMessage.createMany({ data }));
    await batched(r.requestHistoryEntry, (data) => db.requestHistoryEntry.createMany({ data }));
    await batched(r.decision, (data) => db.decision.createMany({ data }));
    const bases = new Map(r.specProposal.map((p) => [p.id, p.baseVersionId ?? null]));
    await batched(
      r.specProposal.map((p) => ({ ...p, baseVersionId: null })),
      (data) => db.specProposal.createMany({ data }),
    );
    await batched(r.specVersion, (data) => db.specVersion.createMany({ data }));
    const withBase = [...bases].filter(([, base]) => base);
    await batched(withBase, async (pairs) => {
      const values = Prisma.join(pairs.map(([id, base]) => Prisma.sql`(${id}, ${base})`));
      await db.$executeRaw`
        UPDATE "SpecProposal" AS p SET "baseVersionId" = v.base
        FROM (VALUES ${values}) AS v(id, base)
        WHERE p.id = v.id`;
    });
    await batched(r.notification, (data) => db.notification.createMany({ data }));
  }
}

async function batched<T>(items: T[], write: (batch: T[]) => Promise<unknown>, size = 5_000) {
  for (let i = 0; i < items.length; i += size) await write(items.slice(i, i + size));
}

/**
 * Inserts chunks with their fake embeddings, the way ContentChunkRepository stores them,
 * a few batches at a time while the next ones are built.
 */
class ChunkSink {
  private pending: Prisma.Sql[] = [];
  private readonly inFlight: Promise<unknown>[] = [];
  private readonly createdAt = new Date(LARGE_ORG_NOW.getTime() - 80 * DAY);
  written = 0;

  constructor(
    private readonly db: PrismaClient,
    private readonly random: SeededRandom,
    private readonly organizationId: string,
    private readonly log: (line: string) => void,
  ) {}

  async add(plan: ChunkPlan) {
    for (const chunk of plan.chunks) {
      const vector = toVectorLiteral(fakeEmbedding(chunk.text, LARGE_ORG_EMBEDDINGS.dims));
      this.pending.push(Prisma.sql`(
        ${this.random.uuid()}, ${this.organizationId}, ${plan.projectId}, ${plan.featureId}::text,
        ${plan.source}::"ChunkSource", ${plan.sourceId}, ${chunk.position}::int, ${chunk.text},
        ${chunk.tokenCount}::int, ${vector}::vector, ${LARGE_ORG_EMBEDDINGS.model}::text,
        ${LARGE_ORG_EMBEDDINGS.dims}::int, ${this.createdAt}
      )`);
      if (this.pending.length === 400) await this.send();
    }
  }

  async finish() {
    await this.send();
    await Promise.all(this.inFlight.splice(0));
  }

  private async send() {
    const rows = this.pending;
    this.pending = [];
    if (!rows.length) return;
    this.inFlight.push(
      Promise.resolve(this.db.$executeRaw`
        INSERT INTO "ContentChunk" (
          "id", "organizationId", "projectId", "featureId", "source", "sourceId", "position",
          "text", "tokenCount", "embedding", "embeddingModel", "embeddingDims", "createdAt"
        ) VALUES ${Prisma.join(rows)}`),
    );
    if (this.inFlight.length >= 4) await this.inFlight.shift();
    const before = this.written;
    this.written += rows.length;
    if (Math.floor(before / 20_000) !== Math.floor(this.written / 20_000)) {
      this.log(`  chunks: ${this.written}`);
    }
  }
}

// ─── Text ───────────────────────────────────────────────────────────────────

function offset(ms: number): Date {
  return new Date(LARGE_ORG_NOW.getTime() + ms);
}

const SYLLABLES = 'ka ri to ne sa mo lu pe vi da no ra shi ten bo ga mi ru ke ya zu fo'.split(' ');

/** Made-up words, so chunks differ from each other and their vectors spread out. */
function makeVocabulary(random: SeededRandom, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    words.add(Array.from({ length: random.int(2, 4) }, () => random.pick(SYLLABLES)).join(''));
  }
  return [...words];
}

function phrase(random: SeededRandom, vocabulary: string[], words: number): string {
  return Array.from({ length: words }, () => random.pick(vocabulary)).join(' ');
}

const SENTENCE_FRAMES = [
  (w: string[]) => `The ${w[0]} ${w[1]} team reviews the ${w[2]} before ${w[3]} goes live.`,
  (w: string[]) => `Every ${w[0]} keeps a ${w[1]} log so ${w[2]} issues reach the ${w[3]} owner.`,
  (w: string[]) => `When ${w[0]} fails, the ${w[1]} service retries ${w[2]} and alerts ${w[3]}.`,
  (w: string[]) => `Customers see ${w[0]} ${w[1]} in the app after ${w[2]} confirms the ${w[3]}.`,
];

function sentence(random: SeededRandom, vocabulary: string[], themes: string[] = []): string {
  const word = () =>
    themes.length && random.chance(0.4) ? random.pick(themes) : random.pick(vocabulary);
  return random.pick(SENTENCE_FRAMES)([word(), word(), word(), word()]);
}

/** A Markdown document of `sections` sections, each one chunk long. */
function generatedDocument(
  random: SeededRandom,
  title: string,
  sections: number,
  vocabulary: string[],
  themes: string[],
): { text: string; chunks: TextChunk[] } {
  const parts = [`# ${title}`];
  for (let s = 0; s < sections; s++) {
    const [heading, topicSentence] = random.pick(TOPICS);
    let body = topicSentence;
    for (;;) {
      const next = `${body} ${sentence(random, vocabulary, themes)}`;
      if (next.length > SECTION_MAX_CHARS) break;
      body = next;
      if (body.length >= SECTION_MIN_CHARS && random.chance(0.3)) break;
    }
    parts.push(`## ${heading} ${s + 1}\n${body}`);
  }
  const text = parts.join('\n\n');
  const chunks = chunkMarkdown(text);
  if (chunks.length !== sections) {
    throw new Error(`Expected ${sections} chunks from a generated document, got ${chunks.length}`);
  }
  return { text, chunks };
}

function specMarkdown(title: string, decided: string[]): string {
  return [
    `# ${title}`,
    '## Goal',
    `Deliver ${title} so that customers and support see the same state at every step.`,
    '## Acceptance criteria',
    '- [ ] The main flow finishes in under one second.',
    '- [ ] Every state change is visible to support with its reference.',
    '- [ ] A failure can be retried from the same screen.',
    '## Out of scope',
    '- Changing providers.',
    ...(decided.length ? ['## Decisions', ...decided.map((d) => `- ${d}`)] : []),
  ].join('\n\n');
}

function briefMarkdown(index: number): string {
  return [
    `# Project ${index + 1}`,
    '## Business goals',
    'Grow active customers and cut support contacts about payments.',
    '## Users',
    'Retail customers on mobile, merchants on the web dashboard, and support agents.',
    '## Constraints',
    'Bank of Thailand rules for e-money; data stays in the country.',
  ].join('\n\n');
}
