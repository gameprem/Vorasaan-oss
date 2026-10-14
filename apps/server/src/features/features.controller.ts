import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import type { FeatureSummaryView, FeatureView } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { featureInOrganizationOf } from '../auth/organization-scope.ts';
import { DeletionService } from '../org/deletion.service.ts';
import { PlatformsService } from '../platforms/platforms.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { AtlassianSettingsService } from '../settings/atlassian-settings.service.ts';
import { OPEN_BLOCKERS } from './open-blockers.ts';

@Controller('features')
export class FeaturesController {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly atlassian: AtlassianSettingsService,
    private readonly platforms: PlatformsService,
    private readonly deletion: DeletionService,
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
    // Its target Platforms in one query of their own, alongside (ticket 0050). Only a Feature
    // of the caller's Organization is found; the targets are dropped with it otherwise.
    const [f, platforms] = await Promise.all([
      this.db.feature.findFirst({
        where: { id, ...featureInOrganizationOf(user.id) },
        include: {
          team: { select: { name: true, project: { select: { id: true, name: true } } } },
          roleOwners: { where: { userId: user.id }, select: { role: true } },
          _count: { select: { decisionRequests: OPEN_BLOCKERS } },
        },
      }),
      this.platforms.targets(this.db, id),
    ]);
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
      platforms,
    };
  }

  /**
   * Deletes the Feature and everything under it (ticket 0049): its PO Role Owners and
   * Admins. Stored Attachment files go once the database delete commits.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.deletion.deleteFeature(user, id);
  }
}
