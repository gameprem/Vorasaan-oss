import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type { ContextBlock, ContextSource } from '../ai/ai.port.ts';
import { clipForAi } from '../attachments/attachment-context.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { CHARS_PER_TOKEN, CHUNKING, estimateTokens } from './chunker.ts';
import {
  ContentChunkRepository,
  type KeywordMatch,
  MAX_SEARCH_K,
  type SearchScope,
} from './content-chunk.repository.ts';
import { assertVectors } from './embedding.port.ts';
import { EmbeddingSettingsService } from './embedding-settings.service.ts';
import { decisionText } from './source-text.ts';

/** Token budgets of the AI tasks that get retrieved context (ADR 0007). */
export const CONTEXT_BUDGET = {
  /** Choice generation and Spec Proposal drafting: the Spec plus the most relevant context. */
  decisionRequest: 6_000,
  /** Drafting a Spec from Attachments: they are the main input. */
  specFromAttachments: 15_000,
} as const;

/** What a block's tag and attributes (kind, id, title...) cost in the prompt, roughly. */
const BLOCK_OVERHEAD_TOKENS = 30;
/** A leftover smaller than this isn't worth a shortened block. */
const MIN_FRAGMENT_TOKENS = 50;
const OPEN_REQUESTS = 10;
const RECENT_DECISIONS = 5;

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

export type RetrieveOptions = {
  /** How many chunks each search returns; by default enough to fill the budget. */
  k?: number;
  /** A Decision Request the prompt already shows in full (e.g. the one being decided). */
  excludeRequestId?: string;
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
 *    Decisions, and Project-level Attachments;
 * 4. when fewer than k of the Feature's chunks matched the query, and there is
 *    room left, its other chunks in reading order (a Spec drafted from the
 *    Attachments needs all of them, not only those that share words with it).
 *
 * Blocks are de-duplicated and kept in that order while they fit; a whole block
 * (Spec, Decision, unindexed Attachment) is shortened to fit, a chunk is skipped.
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
    const k = Math.min(
      MAX_SEARCH_K,
      Math.max(1, options.k ?? Math.max(4, Math.ceil(budget / CHUNKING.targetTokens))),
    );

    const [own, ranked, unindexed] = await Promise.all([
      this.featureMaterial(feature, options.excludeRequestId),
      this.rank(scope, feature.id, query, k),
      this.unindexedAttachments(scope, feature.id),
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
    return fit(candidates, budget);
  }

  /** The Feature's latest Spec, open Decision Requests and recent Decisions. */
  private async featureMaterial(
    feature: { id: string; title: string },
    excludeRequestId: string | undefined,
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
        take: RECENT_DECISIONS,
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
    const search = async (where: SearchScope) => {
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
    };
    const featureScope: SearchScope = { ...scope, featureId, sources: ['ATTACHMENT'] };
    const [feature, project] = await Promise.all([
      search(featureScope),
      search({ ...scope, outsideFeatureId: featureId }),
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
    const [attachments, specs, decisions] = await Promise.all([
      this.db.attachment.findMany({
        where: { id: { in: idsOf('ATTACHMENT') }, feature: inProject },
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
   * The Feature's Attachments with Snapshot text but no chunks yet, most recent
   * Snapshot first: sent whole and shortened to fit, as before retrieval (0023).
   */
  private async unindexedAttachments(scope: Scope, featureId: string): Promise<Candidate[]> {
    const rows = await this.db.attachment.findMany({
      where: { featureId, snapshotText: { not: null } },
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
      return [whole({ kind: 'ATTACHMENT', id, title: row.title }, text)];
    });
  }
}

function whole(source: ContextSource, text: string): Candidate {
  return { source, scope: 'FEATURE', text, key: `${source.kind}:${source.id}`, clippable: true };
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
 * block is the Feature's Spec and not even a fragment of it fits, nothing is
 * returned, so no other block can ever come before the Spec.
 */
function fit(candidates: Candidate[], budget: number): ContextBlock[] {
  const specFirst = splitFeatureSpec(candidates.slice(0, 1)).spec !== null;
  let remaining = Math.max(0, Math.floor(budget));
  const blocks: ContextBlock[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const { key: _key, clippable, ...block } = candidate;
    const cost = blockTokens(block);
    let taken: ContextBlock | null = null;
    if (cost <= remaining) {
      taken = block;
    } else if (clippable) {
      const room = remaining - (cost - estimateTokens(block.text));
      if (room >= MIN_FRAGMENT_TOKENS) {
        taken = { ...block, text: clipForAi(block.text, room * CHARS_PER_TOKEN) };
      }
    }
    if (!taken) {
      if (i === 0 && specFirst) return [];
      continue;
    }
    blocks.push(taken);
    remaining -= blockTokens(taken);
  }
  return blocks;
}

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}
