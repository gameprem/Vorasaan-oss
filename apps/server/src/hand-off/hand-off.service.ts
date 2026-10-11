import { Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  designDocAffected,
  HAND_OFF_BUDGET,
  type HandOffQuery,
  type HandOffView,
  handOffSlug,
  redactCredentials,
  type TeamRole,
} from '@vorasaan/shared';
import { RETRIEVAL_TOP_K } from '../ai/context-budget.ts';
import { personLanguage } from '../ai/language.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { ProjectFoundation, withoutBrief } from '../feature-guidelines/project-foundation.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ContextRetriever } from '../retrieval/context-retriever.ts';
import { clipToTokens, estimateTokens } from '../retrieval/token-estimate.ts';
import { AtlassianSettingsService } from '../settings/atlassian-settings.service.ts';
import { chooseHandOffPlatform, type HandOffTarget, parseHints } from './choose-platform.ts';
import { renderHandOff } from './hand-off-markdown.ts';

/**
 * How a Hand-off's budget is spent (ticket 0079). It is not an AI call of ours, so there is no
 * model window to share (ADR 0012): the budget is the Hand-off's own, and it is split so that
 * retrieval keeps the rules it has everywhere else (ADR 0007, ticket 0076).
 */
export const HAND_OFF_CONFIG = {
  /** The file's own words, the Feature's facts, headings and data tags. */
  frame: 700,
  /** The approved Design Doc takes at most this share of the rest, shortened to fit. */
  designDocShare: 0.3,
  /** The Project rules (Guidelines and Brief), as the foundation of an AI task. */
  foundation: { share: 0.15, ceiling: 4_000 },
  /** Top-k of each search, as a Decision Request's (0076): the Spec and Decisions come first. */
  topK: RETRIEVAL_TOP_K.decisionRequest ?? 15,
  /** The Feature's newest Decisions given before any ranked chunk (retrieval's default is 5). */
  recentDecisions: 20,
} as const;

/** What a data block's tag and heading cost besides its text, roughly. */
const BLOCK_OVERHEAD_TOKENS = 30;

/**
 * The Hand-off (REQUIREMENT 15, ticket 0079): one Feature's distilled context for a coding
 * assistant, which `vorasaan run` writes to `.vorasaan/specs/<feature>.md`. Reading only: it
 * changes nothing, calls no AI and writes no Receipt. Everyone in the Feature's Organization
 * may read it, as they read the Feature; anyone else gets a 404.
 */
@Injectable()
export class HandOffService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly retriever: ContextRetriever,
    private readonly foundation: ProjectFoundation,
    private readonly atlassian: AtlassianSettingsService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async handOff(user: User, featureId: string, query: HandOffQuery = {}): Promise<HandOffView> {
    const feature = await this.db.feature.findFirst({
      where: {
        id: featureId,
        team: { project: { organization: { memberships: { some: { userId: user.id } } } } },
      },
      select: {
        id: true,
        title: true,
        description: true,
        jiraIssueKey: true,
        teamId: true,
        team: { select: { name: true, project: { select: { name: true } } } },
      },
    });
    if (!feature) throw new NotFoundException('Feature not found');

    const [platforms, owned, held, latest, language, jiraIssueUrl] = await Promise.all([
      this.db.platform.findMany({
        where: { features: { some: { featureId } } },
        select: { id: true, name: true, roles: true, position: true },
      }),
      this.db.roleOwner.findMany({ where: { featureId, userId: user.id }, select: { role: true } }),
      this.db.teamMembership.findMany({
        where: { teamId: feature.teamId, userId: user.id },
        select: { role: true },
      }),
      this.db.specVersion.findFirst({
        where: { featureId },
        orderBy: { version: 'desc' },
        select: { version: true, markdown: true },
      }),
      personLanguage(this.db, user.id),
      this.atlassian.jiraIssueUrl(feature.jiraIssueKey),
    ]);
    // The Project's order, sorted here: never by the database's text order.
    const targets: HandOffTarget[] = [...platforms]
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => ({ id: p.id, name: p.name, roles: p.roles as TeamRole[] }));
    const roles = new Set<TeamRole>([...owned, ...held].map((r) => r.role as TeamRole));
    const chosen = chooseHandOffPlatform({
      targets,
      roles,
      asked: query.platform,
      hints: parseHints(query.hint),
    });

    const budget = query.budget ?? HAND_OFF_BUDGET.default;
    const room = budget - HAND_OFF_CONFIG.frame;

    // The approved Design Doc of the Platform: its newest version and the Spec it follows.
    let designDoc:
      | (NonNullable<HandOffView['designDoc']> & { name: string; markdown: string })
      | null = null;
    let designDocNote: string | null = null;
    if (chosen) {
      const doc = await this.db.designDoc.findFirst({
        where: { featureId, platformId: chosen.platform ? chosen.platform.id : null },
        select: {
          versions: {
            orderBy: { version: 'desc' },
            take: 1,
            select: {
              version: true,
              markdown: true,
              specVersion: { select: { version: true, markdown: true } },
            },
          },
        },
      });
      const current = doc?.versions[0];
      if (current) {
        const followed = current.specVersion;
        const stale =
          latest !== null &&
          latest.version !== followed.version &&
          designDocAffected(
            followed.markdown,
            latest.markdown,
            chosen.platform?.name ?? null,
            targets.map((t) => t.name),
          );
        designDoc = {
          name: chosen.name,
          version: current.version,
          specVersion: followed.version,
          stale,
          markdown: clipToTokens(
            current.markdown.trim(),
            Math.floor(room * HAND_OFF_CONFIG.designDocShare),
          ),
        };
      } else {
        designDocNote = `The ${chosen.name} Design Doc has no approved version yet: build from the Spec, and ask before designing what it leaves open.`;
      }
    } else {
      designDocNote = targets.length
        ? 'No Platform was picked, so no Design Doc is handed over: run `vorasaan run --platform <name>` for one.'
        : 'The Feature targets no Platform yet, so it has no Design Doc.';
    }

    const designDocTokens = designDoc
      ? estimateTokens(designDoc.markdown) + BLOCK_OVERHEAD_TOKENS
      : 0;
    const foundationBudget = Math.min(
      HAND_OFF_CONFIG.foundation.ceiling,
      Math.floor(room * HAND_OFF_CONFIG.foundation.share),
    );
    const left = Math.max(0, room - designDocTokens - foundationBudget);
    const { foundation, contextBudget } = await this.foundation.forFeature(featureId, {
      foundation: foundationBudget,
      context: left,
    });
    // What the Project rules didn't use goes to the retrieved context.
    const foundationUsed =
      (foundation.brief ? estimateTokens(foundation.brief.markdown) + BLOCK_OVERHEAD_TOKENS : 0) +
      foundation.guidelines.reduce(
        (sum, g) => sum + estimateTokens(g.title) + estimateTokens(g.description) + 8,
        0,
      );
    const unused = Math.max(0, foundationBudget - foundationUsed);
    const retrievalQuery = [feature.title, feature.description ?? '', chosen?.name ?? '']
      .filter((s) => s.trim())
      .join('\n\n');
    const blocks = withoutBrief(
      await this.retriever.forFeature(featureId, retrievalQuery, contextBudget + unused, {
        k: HAND_OFF_CONFIG.topK,
        recentDecisions: HAND_OFF_CONFIG.recentDecisions,
      }),
    );

    const input = {
      feature: {
        id: feature.id,
        title: feature.title,
        projectName: feature.team.project.name,
        teamName: feature.team.name,
        jiraIssueKey: feature.jiraIssueKey,
        jiraIssueUrl,
      },
      specVersion: latest?.version ?? null,
      platform: chosen ? { name: chosen.name, chosenBy: chosen.chosenBy } : null,
      others: [...targets.map((t) => t.name), 'QA'].filter((n) => n !== chosen?.name),
      designDoc,
      designDocNote,
      foundation,
      blocks,
      language,
      budget,
      generatedAt: this.clock.now(),
    };
    // Counted once, then written with its count; the count's own digits don't change it much.
    const used = estimateTokens(renderHandOff(input, budget));
    const markdown = redactCredentials(renderHandOff(input, used));

    return {
      featureId: feature.id,
      title: feature.title,
      slug: handOffSlug(feature.title, feature.id),
      projectName: feature.team.project.name,
      teamName: feature.team.name,
      jiraIssueKey: feature.jiraIssueKey,
      jiraIssueUrl,
      specVersion: latest?.version ?? null,
      platform: chosen ? { key: chosen.key, name: chosen.name, chosenBy: chosen.chosenBy } : null,
      platforms: [
        ...targets.map((t) => ({ key: t.id, name: t.name })),
        { key: 'qa' as const, name: 'QA' },
      ],
      designDoc: designDoc
        ? {
            name: designDoc.name,
            version: designDoc.version,
            specVersion: designDoc.specVersion,
            stale: designDoc.stale,
          }
        : null,
      designDocNote,
      tokens: { budget, used },
      markdown,
    };
  }
}
