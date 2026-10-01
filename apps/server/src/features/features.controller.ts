import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import type { FeatureSummaryView, FeatureView } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { AtlassianSettingsService } from '../settings/atlassian-settings.service.ts';
import { OPEN_BLOCKERS } from './open-blockers.ts';

@Controller('features')
export class FeaturesController {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly atlassian: AtlassianSettingsService,
  ) {}

  /** Features where the current user is a Role Owner (the CLI's Feature picker and TUI). */
  @Get()
  async mine(@CurrentUser() user: User): Promise<FeatureSummaryView[]> {
    const features = await this.db.feature.findMany({
      where: { roleOwners: { some: { userId: user.id } } },
      orderBy: { title: 'asc' },
      include: {
        team: { select: { name: true, project: { select: { id: true, name: true } } } },
        roleOwners: { where: { userId: user.id }, select: { role: true } },
      },
    });
    return features.map((f) => ({
      id: f.id,
      title: f.title,
      teamId: f.teamId,
      teamName: f.team.name,
      projectId: f.team.project.id,
      projectName: f.team.project.name,
      myRoles: f.roleOwners.map((o) => o.role),
    }));
  }

  @Get(':id')
  async one(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FeatureView> {
    const f = await this.db.feature.findUnique({
      where: { id },
      include: {
        team: { select: { name: true, project: { select: { id: true, name: true } } } },
        roleOwners: { where: { userId: user.id }, select: { role: true } },
        _count: { select: { decisionRequests: OPEN_BLOCKERS } },
      },
    });
    if (!f) throw new NotFoundException('Feature not found');
    return {
      id: f.id,
      title: f.title,
      teamId: f.teamId,
      teamName: f.team.name,
      projectId: f.team.project.id,
      projectName: f.team.project.name,
      myRoles: f.roleOwners.map((o) => o.role),
      jiraIssueKey: f.jiraIssueKey,
      jiraIssueUrl: await this.atlassian.jiraIssueUrl(f.jiraIssueKey),
      openBlockers: f._count.decisionRequests,
    };
  }
}
