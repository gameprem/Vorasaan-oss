import { Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  type CoverageBlocker,
  type CoveragePlatform,
  type FeatureCoverageRow,
  type FeatureCoverageView,
  hasPlatformSection,
  type PlatformCoverage,
  type ProjectCoverageView,
  platformCoverage,
  type TeamRole,
  uncoveredPlatforms,
} from '@vorasaan/shared';
import type { PlatformForAi } from '../ai/ai.port.ts';
import { featureInOrganizationOf } from '../auth/organization-scope.ts';
import { projectAccess } from '../brief/brief-access.ts';
import { OPEN_BLOCKERS } from '../features/open-blockers.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const ordered = [{ position: 'asc' as const }, { id: 'asc' as const }];

const platformSelect = {
  id: true,
  name: true,
  roles: true,
  specSection: true,
  someoneToAsk: true,
  noOpenBlockers: true,
  qaReady: true,
} as const;

/** An open Blocker's title and its Choices' texts, which Coverage matches Platform names in. */
const blockerSelect = {
  id: true,
  title: true,
  featureId: true,
  choices: { select: { title: true, description: true }, orderBy: { position: 'asc' as const } },
} as const;

type BlockerRow = {
  id: string;
  title: string;
  featureId: string;
  choices: { title: string; description: string }[];
};

function missingIn(
  platforms: { name: string; roles: TeamRole[] }[],
  specMarkdown: string,
): PlatformForAi[] {
  return platforms
    .filter((p) => !hasPlatformSection(specMarkdown, p.name))
    .map((p) => ({ name: p.name, roles: p.roles }));
}

function asBlocker(b: BlockerRow): CoverageBlocker {
  return { id: b.id, title: b.title, choices: b.choices.flatMap((c) => [c.title, c.description]) };
}

/**
 * Coverage (ADR 0009, ticket 0051): for each Feature and each Platform it targets, whether
 * that Platform is covered or missing and why, from the latest Spec Version, the roles held
 * in the Feature's Team and its open Blockers. Only the checks a Platform switches on count.
 * The rules themselves are `platformCoverage` in `@vorasaan/shared`; this reads the data,
 * in a fixed number of queries however many Features a Project has.
 */
@Injectable()
export class CoverageService {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  /** One Feature's target Platforms, each covered or missing. Everyone in its Organization reads it. */
  async forFeature(user: User, featureId: string): Promise<FeatureCoverageView> {
    const [feature, platforms, latest, members, blockers] = await Promise.all([
      this.db.feature.findFirst({
        where: { id: featureId, ...featureInOrganizationOf(user.id) },
        select: { id: true },
      }),
      this.db.platform.findMany({
        where: { features: { some: { featureId } } },
        orderBy: ordered,
        select: platformSelect,
      }),
      this.db.specVersion.findFirst({
        where: { featureId },
        orderBy: { version: 'desc' },
        select: { version: true, markdown: true },
      }),
      this.db.teamMembership.findMany({
        where: { team: { features: { some: { id: featureId } } } },
        distinct: ['role'],
        select: { role: true },
      }),
      this.db.decisionRequest.findMany({
        where: { featureId, ...OPEN_BLOCKERS.where },
        select: blockerSelect,
      }),
    ]);
    if (!feature) throw new NotFoundException('Feature not found');
    const coverage = platforms.map((platform) =>
      platformCoverage({
        platform,
        specMarkdown: latest?.markdown ?? null,
        teamRoles: new Set(members.map((m) => m.role)),
        openBlockers: blockers.map(asBlocker),
      }),
    );
    return {
      featureId,
      specVersion: latest?.version ?? null,
      covered: coverage.every((p) => p.covered),
      platforms: coverage,
    };
  }

  /**
   * The Project's Feature × Platform matrix: every Feature of its Teams, by title, with a
   * cell for each Platform it targets; and the Platforms no Feature covers. Everyone in the
   * Organization reads it.
   */
  async forProject(user: User, projectId: string): Promise<ProjectCoverageView> {
    await projectAccess(this.db, user, projectId);
    const { platforms, rows } = await this.matrix(projectId);
    const refs = platforms.map((p) => ({ id: p.id, name: p.name }));
    return {
      projectId,
      platforms: refs,
      features: rows,
      uncovered: uncoveredPlatforms(refs, rows),
    };
  }

  /**
   * The target Platforms whose Spec section `specMarkdown` (the Spec a draft starts from)
   * lacks, among those that switch the "Spec section" check on: what a Spec draft fills in
   * or asks about (ticket 0051).
   */
  async missingSections(featureId: string, specMarkdown: string): Promise<PlatformForAi[]> {
    return missingIn(await this.sectionPlatforms(featureId), specMarkdown);
  }

  /**
   * The same for the Feature's latest Spec Version (none before the first): what a Feature
   * Conversation offers to add as a Spec Proposal (ticket 0052). Two queries run together.
   */
  async missingSectionsOfLatest(featureId: string): Promise<PlatformForAi[]> {
    const [platforms, latest] = await Promise.all([
      this.sectionPlatforms(featureId),
      this.db.specVersion.findFirst({
        where: { featureId },
        orderBy: { version: 'desc' },
        select: { markdown: true },
      }),
    ]);
    return missingIn(platforms, latest?.markdown ?? '');
  }

  /** The Feature's target Platforms that switch the "Spec section" check on, in order. */
  private sectionPlatforms(featureId: string) {
    return this.db.platform.findMany({
      where: { features: { some: { featureId } }, specSection: true },
      orderBy: ordered,
      select: { name: true, roles: true },
    });
  }

  /**
   * The Platforms of a Project no Feature covers, for Grilling to ask about (ticket 0051).
   * None while no Feature of the Project targets any Platform: until then the Project hasn't
   * said which Platforms its Features ship on (0050 left existing Features targeting none),
   * and asking about every Platform would be noise.
   */
  async uncoveredForGrilling(projectId: string): Promise<PlatformForAi[]> {
    const targeted = await this.db.featurePlatform.count({ where: { platform: { projectId } } });
    if (targeted === 0) return [];
    const { platforms, rows } = await this.matrix(projectId);
    const uncovered = new Set(uncoveredPlatforms(platforms, rows).map((p) => p.id));
    return platforms
      .filter((p) => uncovered.has(p.id))
      .map((p) => ({ name: p.name, roles: [...p.roles] }));
  }

  /** Every Feature row of a Project, from six queries run together. */
  private async matrix(
    projectId: string,
  ): Promise<{ platforms: CoveragePlatform[]; rows: FeatureCoverageRow[] }> {
    const [platforms, features, targets, latest, members, blockers] = await Promise.all([
      this.db.platform.findMany({ where: { projectId }, orderBy: ordered, select: platformSelect }),
      this.db.feature.findMany({
        where: { team: { projectId } },
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        select: { id: true, title: true, teamId: true, team: { select: { name: true } } },
      }),
      this.db.featurePlatform.findMany({
        where: { platform: { projectId } },
        select: { featureId: true, platformId: true },
      }),
      // The latest Spec Version of each Feature, in one statement.
      this.db.$queryRaw<{ featureId: string; version: number; markdown: string }[]>`
        SELECT DISTINCT ON (sv."featureId") sv."featureId", sv.version, sv.markdown
        FROM "SpecVersion" sv
        JOIN "Feature" f ON f.id = sv."featureId"
        JOIN "Team" t ON t.id = f."teamId"
        WHERE t."projectId" = ${projectId}
        ORDER BY sv."featureId", sv.version DESC`,
      this.db.teamMembership.findMany({
        where: { team: { projectId } },
        distinct: ['teamId', 'role'],
        select: { teamId: true, role: true },
      }),
      this.db.decisionRequest.findMany({
        where: { feature: { team: { projectId } }, ...OPEN_BLOCKERS.where },
        select: blockerSelect,
      }),
    ]);

    const specs = new Map(latest.map((s) => [s.featureId, s]));
    const rolesOf = new Map<string, Set<TeamRole>>();
    for (const m of members) {
      const roles = rolesOf.get(m.teamId) ?? new Set<TeamRole>();
      roles.add(m.role);
      rolesOf.set(m.teamId, roles);
    }
    const blockersOf = new Map<string, CoverageBlocker[]>();
    for (const b of blockers) {
      blockersOf.set(b.featureId, [...(blockersOf.get(b.featureId) ?? []), asBlocker(b)]);
    }
    const targetsOf = new Map<string, Set<string>>();
    for (const t of targets) {
      const set = targetsOf.get(t.featureId) ?? new Set<string>();
      set.add(t.platformId);
      targetsOf.set(t.featureId, set);
    }

    const rows = features.map((f): FeatureCoverageRow => {
      const spec = specs.get(f.id);
      const targeted = targetsOf.get(f.id) ?? new Set<string>();
      const cells: PlatformCoverage[] = platforms
        .filter((p) => targeted.has(p.id))
        .map((platform) =>
          platformCoverage({
            platform,
            specMarkdown: spec?.markdown ?? null,
            teamRoles: rolesOf.get(f.teamId) ?? new Set(),
            openBlockers: blockersOf.get(f.id) ?? [],
          }),
        );
      return {
        featureId: f.id,
        title: f.title,
        teamId: f.teamId,
        teamName: f.team.name,
        specVersion: spec?.version ?? null,
        covered: cells.every((c) => c.covered),
        platforms: cells,
      };
    });
    return { platforms, rows };
  }
}
