import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import type { ChunkSource, PrismaClient } from '@vorasaan/db';
import type { ReindexResult } from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { chunkMarkdown } from './chunker.ts';
import {
  type ChunkEmbeddings,
  type ChunkScope,
  ContentChunkRepository,
  sourceKey,
} from './content-chunk.repository.ts';
import { assertVectors } from './embedding.port.ts';
import { EmbeddingSettingsService } from './embedding-settings.service.ts';

export type IndexTarget = { source: ChunkSource; id: string };

type Loaded = { scope: ChunkScope; text: string } | null;

const scopeSelect = {
  id: true,
  team: { select: { project: { select: { id: true, organizationId: true } } } },
} as const;

type FeatureScope = {
  id: string;
  team: { project: { id: string; organizationId: string } };
};

/**
 * Keeps ContentChunk in step with the content it is cut from (ADR 0007):
 * Attachment Snapshots, the latest Spec Version of each Feature, and Decisions.
 *
 * Callers `schedule()` a source once their transaction has committed. Jobs run one
 * at a time in the background, read the source as it is when they run, and replace
 * its chunks. They never fail or slow the user's action: an error is logged, and a
 * failed embedding call stores the chunks without vectors, for the re-index to fix.
 */
@Injectable()
export class IndexingService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(IndexingService.name);
  private queue: Promise<void> = Promise.resolve();
  private readonly waiting = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly chunks: ContentChunkRepository,
    private readonly embeddings: EmbeddingSettingsService,
  ) {}

  /** Queues sources for (re-)indexing. Never throws and never waits. */
  schedule(...targets: IndexTarget[]): void {
    for (const target of targets) {
      const key = sourceKey({ source: target.source, sourceId: target.id });
      if (this.waiting.has(key)) continue; // already queued and not started: it will read the latest
      this.waiting.add(key);
      const job = this.queue.then(async () => {
        this.waiting.delete(key);
        try {
          await this.index(target);
        } catch (error) {
          this.logger.error(`Could not index ${key}: ${(error as Error)?.message ?? error}`);
        }
      });
      this.queue = job;
      this.jobs.add(job);
      void job.finally(() => this.jobs.delete(job));
    }
  }

  /** Resolves once every queued job has finished. */
  async drain(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.drain();
  }

  /**
   * Queues every source of the Organization (`all`), or only those not yet indexed,
   * without vectors, or embedded by another model than the current one (`stale`).
   */
  async reindex(organizationId: string, scope: 'all' | 'stale'): Promise<ReindexResult> {
    const inOrg = { team: { project: { organizationId } } };
    const [attachments, specVersions, decisions] = await Promise.all([
      this.db.attachment.findMany({
        where: { feature: inOrg, snapshotText: { not: null } },
        select: { id: true },
      }),
      this.db.specVersion.findMany({
        where: { feature: inOrg },
        distinct: ['featureId'],
        orderBy: [{ featureId: 'asc' }, { version: 'desc' }],
        select: { id: true },
      }),
      this.db.decision.findMany({
        where: { request: { feature: inOrg } },
        select: { id: true },
      }),
    ]);
    let targets: IndexTarget[] = [
      ...attachments.map((a) => ({ source: 'ATTACHMENT' as const, id: a.id })),
      ...specVersions.map((v) => ({ source: 'SPEC_VERSION' as const, id: v.id })),
      ...decisions.map((d) => ({ source: 'DECISION' as const, id: d.id })),
    ];
    if (scope === 'stale') {
      const model = await this.embeddings.model(organizationId);
      const upToDate = await this.chunks.upToDateSources(organizationId, model);
      targets = targets.filter(
        (t) => !upToDate.has(sourceKey({ source: t.source, sourceId: t.id })),
      );
    }
    this.schedule(...targets);
    return { queued: targets.length };
  }

  /** Re-chunks and re-embeds one source now; a source that is gone loses its chunks. */
  async index(target: IndexTarget): Promise<void> {
    const ref = { source: target.source, sourceId: target.id };
    const loaded = await this.load(target);
    if (!loaded) {
      await this.chunks.deleteSource(ref);
      return;
    }
    const pieces = chunkMarkdown(loaded.text);
    const embeddings = pieces.length
      ? await this.embed(
          loaded.scope.organizationId,
          pieces.map((p) => p.text),
          target,
        )
      : null;
    await this.chunks.replace(loaded.scope, ref, pieces, embeddings);
    if (target.source === 'SPEC_VERSION' && loaded.scope.featureId) {
      await this.chunks.deleteOtherSpecVersions(loaded.scope.featureId, target.id);
    }
  }

  /** Vectors from the Organization's provider; null when none is set or the call fails. */
  private async embed(
    organizationId: string,
    texts: string[],
    target: IndexTarget,
  ): Promise<ChunkEmbeddings | null> {
    const port = await this.embeddings.port(organizationId);
    if (!port) return null;
    try {
      const vectors = await port.embed(texts);
      assertVectors(vectors, texts.length);
      return { model: port.model, vectors };
    } catch (error) {
      this.logger.warn(
        `Could not embed ${target.source}:${target.id}; stored without vectors until re-indexed: ` +
          `${(error as Error)?.message ?? error}`,
      );
      return null;
    }
  }

  private load(target: IndexTarget): Promise<Loaded> {
    switch (target.source) {
      case 'ATTACHMENT':
        return this.loadAttachment(target.id);
      case 'SPEC_VERSION':
        return this.loadSpecVersion(target.id);
      case 'DECISION':
        return this.loadDecision(target.id);
    }
  }

  private async loadAttachment(id: string): Promise<Loaded> {
    const attachment = await this.db.attachment.findUnique({
      where: { id },
      select: { snapshotText: true, feature: { select: scopeSelect } },
    });
    if (!attachment) return null;
    return { scope: scopeOf(attachment.feature), text: attachment.snapshotText ?? '' };
  }

  /** Only the Feature's latest Spec Version is indexed; an older one has no chunks. */
  private async loadSpecVersion(id: string): Promise<Loaded> {
    const version = await this.db.specVersion.findUnique({
      where: { id },
      select: { markdown: true, featureId: true, feature: { select: scopeSelect } },
    });
    if (!version) return null;
    const latest = await this.db.specVersion.findFirst({
      where: { featureId: version.featureId },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== id) return null;
    return { scope: scopeOf(version.feature), text: version.markdown };
  }

  private async loadDecision(id: string): Promise<Loaded> {
    const decision = await this.db.decision.findUnique({
      where: { id },
      select: {
        customAnswer: true,
        rationale: true,
        choice: { select: { label: true, title: true, description: true } },
        request: {
          select: { title: true, description: true, feature: { select: scopeSelect } },
        },
      },
    });
    if (!decision) return null;
    const outcome = decision.choice
      ? `Choice ${decision.choice.label}: ${decision.choice.title}\n\n${decision.choice.description}`
      : (decision.customAnswer ?? '');
    const text = [
      `# Decision: ${decision.request.title}`,
      decision.request.description,
      `## Decided\n${outcome}`,
      decision.rationale ? `## Rationale\n${decision.rationale}` : '',
    ]
      .filter((part) => part.trim())
      .join('\n\n');
    return { scope: scopeOf(decision.request.feature), text };
  }
}

function scopeOf(feature: FeatureScope): ChunkScope {
  return {
    organizationId: feature.team.project.organizationId,
    projectId: feature.team.project.id,
    featureId: feature.id,
  };
}
