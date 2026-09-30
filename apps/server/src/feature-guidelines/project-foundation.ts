import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type { EffectiveGuidelineCriterion } from '@vorasaan/shared';
import type { ContextBlock, GuidelineForAi, ProjectFoundationForAi } from '../ai/ai.port.ts';
import { clipForAi } from '../attachments/attachment-context.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { CHARS_PER_TOKEN, estimateTokens } from '../retrieval/chunker.ts';
import { FeatureGuidelinesService } from './feature-guidelines.service.ts';

/** How much of a Feature task's budget the Project Brief may take, at most. */
export const FOUNDATION_BRIEF_TOKENS = 1_500;
/** A Guideline's description is shortened to this in a Feature task's prompt. */
const GUIDELINE_DESCRIPTION_CHARS = 300;
/** What a Guideline's line costs beyond its text, roughly. */
const GUIDELINE_OVERHEAD_TOKENS = 8;

/** An effective Guideline with the handle ("G1"...) the AI cites it by. */
export type ReferencedGuideline = GuidelineForAi & {
  ref: string;
  criterion: EffectiveGuidelineCriterion;
};

/**
 * What every AI workflow in a Project reads besides its retrieved context
 * (ADR 0006): the latest Brief Version and the effective Feature Guidelines.
 */
@Injectable()
export class ProjectFoundation {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly guidelines: FeatureGuidelinesService,
  ) {}

  /** The effective Guidelines, each with a handle "G1", "G2"... in their order. */
  async referencedGuidelines(projectId: string): Promise<ReferencedGuideline[]> {
    const criteria = await this.guidelines.effective(projectId);
    return criteria.map((criterion, i) => ({
      ref: `G${i + 1}`,
      title: criterion.title,
      description: criterion.description,
      kind: criterion.kind,
      required: criterion.required,
      criterion,
    }));
  }

  /**
   * The Brief (shortened to FOUNDATION_BRIEF_TOKENS) and the effective Guidelines
   * (descriptions shortened) for a task on this Feature, and how many tokens of
   * `budget` are left for retrieved context. The retrieval keeps at least half
   * the budget, so only very long Guidelines can push the total over it.
   */
  async forFeature(
    featureId: string,
    budget: number,
  ): Promise<{ foundation: ProjectFoundationForAi; contextBudget: number }> {
    const feature = await this.db.feature.findUnique({
      where: { id: featureId },
      select: { team: { select: { projectId: true } } },
    });
    if (!feature) return { foundation: { brief: null, guidelines: [] }, contextBudget: budget };
    const { projectId } = feature.team;
    const [latest, criteria] = await Promise.all([
      this.db.briefVersion.findFirst({
        where: { projectId },
        orderBy: { version: 'desc' },
        select: { version: true, markdown: true },
      }),
      this.guidelines.effective(projectId),
    ]);
    const guidelines: GuidelineForAi[] = criteria.map((c) => ({
      title: c.title,
      description: clipForAi(c.description, GUIDELINE_DESCRIPTION_CHARS),
      kind: c.kind,
      required: c.required,
    }));
    const guidelineTokens = guidelines.reduce(
      (sum, g) =>
        sum + estimateTokens(g.title) + estimateTokens(g.description) + GUIDELINE_OVERHEAD_TOKENS,
      0,
    );
    const brief = latest
      ? {
          version: latest.version,
          markdown: clipForAi(latest.markdown.trim(), FOUNDATION_BRIEF_TOKENS * CHARS_PER_TOKEN),
        }
      : null;
    const used = guidelineTokens + (brief ? estimateTokens(brief.markdown) : 0);
    return {
      foundation: { brief, guidelines },
      contextBudget: Math.max(Math.floor(budget / 2), budget - used),
    };
  }
}

/** Retrieved blocks without the Project Brief, when the prompt already shows it on its own. */
export function withoutBrief(blocks: ContextBlock[]): ContextBlock[] {
  return blocks.filter((b) => b.source.kind !== 'BRIEF_VERSION');
}
