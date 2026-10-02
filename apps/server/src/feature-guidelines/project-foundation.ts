import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type { EffectiveGuidelineCriterion } from '@vorasaan/shared';
import type { ContextBlock, GuidelineForAi, ProjectFoundationForAi } from '../ai/ai.port.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { clipToTokens, estimateTokens } from '../retrieval/token-estimate.ts';
import { FeatureGuidelinesService } from './feature-guidelines.service.ts';

/** A Guideline's description is shortened to this many tokens in a Feature task's prompt. */
const GUIDELINE_DESCRIPTION_TOKENS = 75;
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
   * The effective Guidelines (descriptions shortened) and the Brief, shortened to
   * what the foundation's budget (ticket 0060) leaves after the Guidelines, for a
   * task on this Feature, and how many tokens are left for retrieved context:
   * `budget.context`, less whatever the Guidelines took beyond the foundation's
   * budget, so the total never goes over.
   */
  async forFeature(
    featureId: string,
    budget: { foundation: number; context: number },
  ): Promise<{ foundation: ProjectFoundationForAi; contextBudget: number }> {
    const feature = await this.db.feature.findUnique({
      where: { id: featureId },
      select: { team: { select: { projectId: true } } },
    });
    if (!feature) {
      return { foundation: { brief: null, guidelines: [] }, contextBudget: budget.context };
    }
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
      description: clipToTokens(c.description, GUIDELINE_DESCRIPTION_TOKENS),
      kind: c.kind,
      required: c.required,
    }));
    const guidelineTokens = guidelines.reduce(
      (sum, g) =>
        sum + estimateTokens(g.title) + estimateTokens(g.description) + GUIDELINE_OVERHEAD_TOKENS,
      0,
    );
    const briefBudget = Math.max(0, budget.foundation - guidelineTokens);
    const brief = latest
      ? { version: latest.version, markdown: clipToTokens(latest.markdown.trim(), briefBudget) }
      : null;
    const overflow = Math.max(0, guidelineTokens - budget.foundation);
    return {
      foundation: { brief, guidelines },
      contextBudget: Math.max(0, Math.floor(budget.context - overflow)),
    };
  }
}

/** Retrieved blocks without the Project Brief, when the prompt already shows it on its own. */
export function withoutBrief(blocks: ContextBlock[]): ContextBlock[] {
  return blocks.filter((b) => b.source.kind !== 'BRIEF_VERSION');
}
