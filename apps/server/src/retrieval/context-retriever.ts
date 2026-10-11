import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type { ContextBlock, ContextSource } from '../ai/ai.port.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { CHUNKING } from './chunker.ts';
import {
  ContentChunkRepository,
  type KeywordMatch,
  MAX_SEARCH_K,
  type SearchScope,
} from './content-chunk.repository.ts';
import { type ShownText, shown, unrepeated } from './context-dedupe.ts';
import { assertVectors } from './embedding.port.ts';
import { EmbeddingSettingsService } from './embedding-settings.service.ts';
import { decisionText } from './source-text.ts';
import { clipToTokens, estimateTokens } from './token-estimate.ts';

/** What a block's tag and attributes (kind, id, title...) cost in the prompt, roughly. */
export const BLOCK_OVERHEAD_TOKENS = 30;
/** A leftover smaller than this isn't worth a shortened block. */
const MIN_FRAGMENT_TOKENS = 50;
const OPEN_REQUESTS = 10;
const RECENT_DECISIONS = 5;
/** Project-level retrieval lists this many Features, most recently changed first... */
const FEATURE_OVERVIEW = 25;
/** ...each with the start of its latest Spec, this many tokens long. */
const FEATURE_SPEC_EXCERPT_TOKENS = 200;

/** What one block costs against the budget: its text, its title and its tag. */
export function blockTokens(block: ContextBlock): number {
  return estimateTokens(block.text) + estimateTokens(block.source.title) + BLOCK_OVERHEAD_TOKENS;
}

/** Splits the Feature's own Spec (always the first block, when there is one) from the rest. */
export function splitFeatureSpec(blocks: ContextBlock[]): {
  spec: ContextBlock | null;
  context: ContextBlock[];
} {
  const [first, ...rest] = blocks;
  if (first?.scope === 'FEATURE' && first.source.kind === 'SPEC_VERSION') {
    return { spec: first, context: rest };
  }
  return { spec: null, context: blocks };
}

/** Splits the Project Brief (the first block of `forProject`, when there is one) from the rest. */
export function splitProjectBrief(blocks: ContextBlock[]): {
  brief: ContextBlock | null;
  context: ContextBlock[];
} {
  const [first, ...rest] = blocks;
  if (first?.source.kind === 'BRIEF_VERSION') return { brief: first, context: rest };
  return { brief: null, context: blocks };
}

export type RetrieveOptions = {
  /** How many chunks each search returns; by default enough to fill the budget. */
  k?: number;
  /** A Decision Request the prompt already shows in full (e.g. the one being decided). */
  excludeRequestId?: string;
  /** How many of the Feature's newest Decisions come first (RECENT_DECISIONS by default). */
  recentDecisions?: number;
};

/** A block on its way to the prompt: `key` for de-duplication, `clippable` if it may be shortened. */
type Candidate = ContextBlock & { key: string; clippable: boolean };

type Scope = { organizationId: string; projectId: string };

/**
 * The context every AI workflow gets (ADR 0007): the smallest set of blocks that
 * answers the query, within a token budget, in this order:
 *
 * 1. the Feature's latest Spec (always first), its open Decision Requests and
 *    its recent Decisions;
 * 2. the top-k chunks of the Feature's own Attachments for the query; then its
 *    Attachments not indexed yet (the background job hasn't run), whole and
 *    shortened to fit (0023's truncation, the last resort);
 * 3. the top-k chunks from the rest of the Project: other Features' Specs and
 *    Decisions, the Project Brief (its latest Brief Version) and Project-level
 *    Attachments;
 * 4. when fewer than k of the Feature's chunks matched the query, and there is
 *    room left, its other chunks in reading order (a Spec drafted from the
 *    Attachments needs all of them, not only those that share words with it).
 *
 * Blocks are de-duplicated and kept in that order while they fit; a whole block
 * (Spec, Decision, unindexed Attachment) is shortened to fit, a chunk is skipped. A
 * chunk whose text an earlier block already holds is skipped too, and a start it repeats
 * from its own source (the chunker's overlap) is cut (ticket 0076, `context-dedupe.ts`).
 *
 * Ranking uses the Organization's embeddings when a provider is set; without one,
 * or when the query can't be embedded, it falls back to Postgres full-text
 * ranking (`ts_rank`) over the same chunks. Every search is scoped to the
 * Feature's Organization and Project, so nothing leaks between Projects.
 */
@Injectable()
export class ContextRetriever {
  private readonly logger = new Logger(ContextRetriever.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly chunks: ContentChunkRepository,
    private readonly embeddings: EmbeddingSettingsService,
  ) {}

  async forFeature(
    featureId: string,
    query: string,
    budget: number,
    options: RetrieveOptions = {},
  ): Promise<ContextBlock[]> {
    const feature = await this.db.feature.findUnique({
      where: { id: featureId },
      select: {
        id: true,
        title: true,
        team: { select: { project: { select: { id: true, organizationId: true } } } },
      },
    });
    if (!feature) return [];
    const scope: Scope = {
      organizationId: feature.team.project.organizationId,
      projectId: feature.team.project.id,
    };
    const k = searchK(budget, options.k);

    const [own, ranked, unindexed] = await Promise.all([
      this.featureMaterial(
        feature,
        options.excludeRequestId,
        options.recentDecisions ?? RECENT_DECISIONS,
      ),
      this.rank(scope, feature.id, query, k),
      this.unindexedAttachments(scope, { featureId: feature.id }, 'FEATURE'),
    ]);
    const [featureChunks, projectChunks, fillerChunks] = await Promise.all([
      this.describe(scope, ranked.feature, 'FEATURE'),
      this.describe(scope, ranked.project, 'PROJECT'),
      this.describe(scope, ranked.filler, 'FEATURE'),
    ]);
    const candidates = dedupe([
      ...own,
      ...featureChunks,
      ...unindexed,
      ...projectChunks,
      ...fillerChunks,
    ]);
    return fit(candidates, budget, splitFeatureSpec(candidates.slice(0, 1)).spec !== null);
  }

  /**
   * The context of a Project-level workflow (Grilling), within `budget` tokens,
   * by the same rules as `forFeature`, in this order:
   *
   * 1. the Project Brief's latest Brief Version (always first, shortened to fit);
   * 2. an overview of the Project's Features, most recently changed first: each
   *    with its status, description and the start of its latest Spec;
   * 3. the top-k chunks of the Project Attachments (documents, and the Repo Scan
   *    summary when there is one) for the query; then those not indexed yet,
   *    whole and shortened to fit;
   * 4. the top-k chunks of the Features' Specs and Decisions for the query;
   * 5. when fewer than k Project Attachment chunks matched, and there is room
   *    left, their other chunks in reading order.
   *
   * Feature Attachments belong to their Feature and are left out. Every search is
   * scoped to the Project and its Organization.
   */
  async forProject(
    projectId: string,
    query: string,
    budget: number,
    options: Pick<RetrieveOptions, 'k'> = {},
  ): Promise<ContextBlock[]> {
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true },
    });
    if (!project) return [];
    const scope: Scope = { organizationId: project.organizationId, projectId: project.id };
    const k = searchK(budget, options.k);
    const attachmentScope: SearchScope = { ...scope, projectLevel: true, sources: ['ATTACHMENT'] };

    const vector = await this.embedQuery(scope.organizationId, query);
    const [brief, features, attachmentHits, restHits, unindexed] = await Promise.all([
      this.latestBrief(project.id),
      this.featureOverview(project.id),
      this.search(attachmentScope, vector, query, k),
      this.search({ ...scope, sources: ['SPEC_VERSION', 'DECISION'] }, vector, query, k),
      this.unindexedAttachments(scope, { projectId: project.id }, 'PROJECT'),
    ]);
    const fillerHits =
      attachmentHits.length < k
        ? await this.chunks.inOrder(
            attachmentScope,
            k - attachmentHits.length,
            attachmentHits.map((h) => h.id),
          )
        : [];
    const [attachmentChunks, restChunks, fillerChunks] = await Promise.all([
      this.describe(scope, attachmentHits, 'PROJECT'),
      this.describe(scope, restHits, 'PROJECT'),
      this.describe(scope, fillerHits, 'PROJECT'),
    ]);
    const candidates = dedupe([
      ...(brief ? [brief] : []),
      ...features,
      ...attachmentChunks,
      ...unindexed,
      ...restChunks,
      ...fillerChunks,
    ]);
    return fit(candidates, budget, brief !== null && candidates[0] === brief);
  }

  private async latestBrief(projectId: string): Promise<Candidate | null> {
    const latest = await this.db.briefVersion.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, markdown: true },
    });
    if (!latest) return null;
    return whole(
      { kind: 'BRIEF_VERSION', id: latest.id, title: 'Project Brief', version: latest.version },
      latest.markdown,
      'PROJECT',
    );
  }

  /** The Project's Features, each with its status, description and the start of its latest Spec. */
  private async featureOverview(projectId: string): Promise<Candidate[]> {
    const features = await this.db.feature.findMany({
      where: { team: { projectId } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: FEATURE_OVERVIEW,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        specVersions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, version: true, markdown: true },
        },
      },
    });
    return features.map((f) => {
      const header = [`Status: ${f.status}`, f.description?.trim()].filter(Boolean).join('\n\n');
      const spec = f.specVersions[0];
      if (!spec) {
        return whole(
          { kind: 'FEATURE', id: f.id, title: `Feature: ${f.title}` },
          header,
          'PROJECT',
        );
      }
      return whole(
        { kind: 'SPEC_VERSION', id: spec.id, title: `Spec: ${f.title}`, version: spec.version },
        `${header}\n\n${clipToTokens(spec.markdown.trim(), FEATURE_SPEC_EXCERPT_TOKENS)}`,
        'PROJECT',
      );
    });
  }

  /** The Feature's latest Spec, open Decision Requests and recent Decisions. */
  private async featureMaterial(
    feature: { id: string; title: string },
    excludeRequestId: string | undefined,
    recentDecisions: number,
  ): Promise<Candidate[]> {
    const notExcluded = excludeRequestId ? { not: excludeRequestId } : undefined;
    const [spec, requests, decisions] = await Promise.all([
      this.db.specVersion.findFirst({
        where: { featureId: feature.id },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, markdown: true },
      }),
      this.db.decisionRequest.findMany({
        where: { featureId: feature.id, status: { in: ['OPEN', 'NEEDS_INFO'] }, id: notExcluded },
        orderBy: { createdAt: 'desc' },
        take: OPEN_REQUESTS,
        select: { id: true, kind: true, title: true, description: true },
      }),
      this.db.decision.findMany({
        where: { request: { featureId: feature.id, id: notExcluded } },
        orderBy: { createdAt: 'desc' },
        take: recentDecisions,
        select: {
          id: true,
          customAnswer: true,
          rationale: true,
          choice: { select: { label: true, title: true, description: true } },
          request: { select: { title: true, description: true } },
        },
      }),
    ]);
    const blocks: Candidate[] = [];
    if (spec) {
      blocks.push(
        whole(
          {
            kind: 'SPEC_VERSION',
            id: spec.id,
            title: `Spec: ${feature.title}`,
            version: spec.version,
          },
          spec.markdown,
        ),
      );
    }
    for (const r of requests) {
      blocks.push(
        whole(
          { kind: 'DECISION_REQUEST', id: r.id, title: `Open Decision Request: ${r.title}` },
          `Kind: ${r.kind}\n\n${r.description}`,
        ),
      );
    }
    for (const d of decisions) {
      blocks.push(
        whole(
          { kind: 'DECISION', id: d.id, title: `Decision: ${d.request.title}` },
          decisionText(d),
        ),
      );
    }
    return blocks;
  }

  /**
   * The best chunks for the query in the Feature's Attachments and in the rest of
   * the Project: by vector distance when the query can be embedded, topped up by
   * keyword rank; plus the filler from the Feature's own Attachments, in reading order.
   */
  private async rank(
    scope: Scope,
    featureId: string,
    query: string,
    k: number,
  ): Promise<{ feature: KeywordMatch[]; project: KeywordMatch[]; filler: KeywordMatch[] }> {
    const vector = await this.embedQuery(scope.organizationId, query);
    const featureScope: SearchScope = { ...scope, featureId, sources: ['ATTACHMENT'] };
    const [feature, project] = await Promise.all([
      this.search(featureScope, vector, query, k),
      this.search({ ...scope, outsideFeatureId: featureId }, vector, query, k),
    ]);
    const filler =
      feature.length < k
        ? await this.chunks.inOrder(
            featureScope,
            k - feature.length,
            feature.map((h) => h.id),
          )
        : [];
    return { feature, project, filler };
  }

  /** The `k` best chunks in `where`: nearest by vector when there is one, topped up by keyword rank. */
  private async search(
    where: SearchScope,
    vector: { model: string; embedding: number[] } | null,
    query: string,
    k: number,
  ): Promise<KeywordMatch[]> {
    const hits: KeywordMatch[] = [];
    if (vector) {
      try {
        const nearest = await this.chunks.search(where, vector, k);
        hits.push(...nearest.map(({ distance, ...chunk }) => ({ ...chunk, rank: 1 - distance })));
      } catch (error) {
        this.logger.warn(`Vector search failed, using keywords: ${message(error)}`);
      }
    }
    if (hits.length < k) {
      const seen = new Set(hits.map((h) => h.id));
      const keyword = await this.chunks.keywordSearch(where, query, k);
      hits.push(...keyword.filter((h) => !seen.has(h.id)).slice(0, k - hits.length));
    }
    return hits;
  }

  /** The query's embedding, or null when no provider is set or the call fails. */
  private async embedQuery(
    organizationId: string,
    query: string,
  ): Promise<{ model: string; embedding: number[] } | null> {
    if (!query.trim()) return null;
    try {
      const port = await this.embeddings.port(organizationId);
      if (!port) return null;
      const vectors = await port.embed([query]);
      assertVectors(vectors, 1);
      const [embedding] = vectors;
      return embedding ? { model: port.model, embedding } : null;
    } catch (error) {
      this.logger.warn(`Could not embed the query, using keywords: ${message(error)}`);
      return null;
    }
  }

  /**
   * Chunks as blocks, titled after their source. A chunk whose source is gone,
   * or isn't in this Project, is dropped.
   */
  private async describe(
    scope: Scope,
    hits: KeywordMatch[],
    blockScope: ContextBlock['scope'],
  ): Promise<Candidate[]> {
    if (!hits.length) return [];
    const idsOf = (source: KeywordMatch['source']) => [
      ...new Set(hits.filter((h) => h.source === source).map((h) => h.sourceId)),
    ];
    const inProject = {
      team: { project: { id: scope.projectId, organizationId: scope.organizationId } },
    };
    const [attachments, specs, decisions, briefs] = await Promise.all([
      this.db.attachment.findMany({
        where: {
          id: { in: idsOf('ATTACHMENT') },
          OR: [
            { feature: inProject },
            { project: { id: scope.projectId, organizationId: scope.organizationId } },
          ],
        },
        select: { id: true, title: true },
      }),
      this.db.specVersion.findMany({
        where: { id: { in: idsOf('SPEC_VERSION') }, feature: inProject },
        select: { id: true, version: true, feature: { select: { title: true } } },
      }),
      this.db.decision.findMany({
        where: { id: { in: idsOf('DECISION') }, request: { feature: inProject } },
        select: { id: true, request: { select: { title: true } } },
      }),
      this.db.briefVersion.findMany({
        where: {
          id: { in: idsOf('BRIEF_VERSION') },
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
        select: { id: true, version: true },
      }),
    ]);
    const sources = new Map<string, ContextSource>();
    for (const a of attachments) {
      sources.set(`ATTACHMENT:${a.id}`, { kind: 'ATTACHMENT', id: a.id, title: a.title });
    }
    for (const s of specs) {
      sources.set(`SPEC_VERSION:${s.id}`, {
        kind: 'SPEC_VERSION',
        id: s.id,
        title: `Spec: ${s.feature.title}`,
        version: s.version,
      });
    }
    for (const b of briefs) {
      sources.set(`BRIEF_VERSION:${b.id}`, {
        kind: 'BRIEF_VERSION',
        id: b.id,
        title: 'Project Brief',
        version: b.version,
      });
    }
    for (const d of decisions) {
      sources.set(`DECISION:${d.id}`, {
        kind: 'DECISION',
        id: d.id,
        title: `Decision: ${d.request.title}`,
      });
    }
    return hits.flatMap((hit) => {
      const source = sources.get(`${hit.source}:${hit.sourceId}`);
      if (!source) return [];
      return [
        { source, scope: blockScope, text: hit.text, key: `chunk:${hit.id}`, clippable: false },
      ];
    });
  }

  /**
   * The Feature's (or the Project's own) Attachments with Snapshot text but no
   * chunks yet, most recent Snapshot first: sent whole and shortened to fit, as
   * before retrieval (0023).
   */
  private async unindexedAttachments(
    scope: Scope,
    owner: { featureId: string } | { projectId: string },
    blockScope: ContextBlock['scope'],
  ): Promise<Candidate[]> {
    const rows = await this.db.attachment.findMany({
      where: { ...owner, snapshotText: { not: null } },
      orderBy: [{ snapshotAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    const indexed = await this.chunks.indexedSourceIds(scope.organizationId, 'ATTACHMENT', ids);
    const missing = ids.filter((id) => !indexed.has(id));
    if (!missing.length) return [];
    const texts = await this.db.attachment.findMany({
      where: { id: { in: missing } },
      select: { id: true, title: true, snapshotText: true },
    });
    const byId = new Map(texts.map((t) => [t.id, t]));
    return missing.flatMap((id) => {
      const row = byId.get(id);
      const text = row?.snapshotText?.trim();
      if (!row || !text) return [];
      return [whole({ kind: 'ATTACHMENT', id, title: row.title }, text, blockScope)];
    });
  }
}

function whole(
  source: ContextSource,
  text: string,
  scope: ContextBlock['scope'] = 'FEATURE',
): Candidate {
  return { source, scope, text, key: `${source.kind}:${source.id}`, clippable: true };
}

/** How many chunks each search returns: `k` if given, else enough to fill the budget. */
function searchK(budget: number, k: number | undefined): number {
  return Math.min(
    MAX_SEARCH_K,
    Math.max(1, k ?? Math.max(4, Math.ceil(budget / CHUNKING.targetTokens))),
  );
}

/** Drops repeated blocks: the same chunk or source twice, or the same text twice. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const keys = new Set<string>();
  const texts = new Set<string>();
  return candidates.filter((c) => {
    const text = c.text.replace(/\s+/g, ' ').trim();
    if (!text || keys.has(c.key) || texts.has(text)) return false;
    keys.add(c.key);
    texts.add(text);
    return true;
  });
}

/**
 * Keeps blocks in order while they fit in `budget` tokens. A whole block that
 * doesn't fit is shortened to the room left; a chunk is skipped. When the first
 * block is anchored (the Feature's Spec, or the Project Brief) and not even a
 * fragment of it fits, nothing is returned, so no other block can ever come
 * before it.
 */
function fit(candidates: Candidate[], budget: number, anchoredFirst: boolean): ContextBlock[] {
  let remaining = Math.max(0, Math.floor(budget));
  const blocks: ContextBlock[] = [];
  const before: ShownText[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const { key: _key, clippable, ...found } = candidate;
    let block: ContextBlock = found;
    // A chunk never repeats what the prompt already shows (ticket 0076).
    if (!clippable) {
      const text = unrepeated(block, before);
      if (text === null) continue;
      if (text !== block.text) block = { ...block, text };
    }
    const cost = blockTokens(block);
    let taken: ContextBlock | null = null;
    if (cost <= remaining) {
      taken = block;
    } else if (clippable) {
      const room = remaining - (cost - estimateTokens(block.text));
      if (room >= MIN_FRAGMENT_TOKENS) {
        taken = { ...block, text: clipToTokens(block.text, room) };
      }
    }
    if (!taken) {
      if (i === 0 && anchoredFirst) return [];
      continue;
    }
    blocks.push(taken);
    before.push(shown(taken));
    remaining -= blockTokens(taken);
  }
  return blocks;
}

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}
