import { Controller, Get } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import type { FeatureSummaryView } from '@vorasaan/shared';
import { CurrentUser } from '../dev-identity/dev-user.guard.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

@Controller('features')
export class FeaturesController {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  /** Features where the current user is a Role Owner (the CLI's Feature picker). */
  @Get()
  async mine(@CurrentUser() user: User): Promise<FeatureSummaryView[]> {
    const features = await this.db.feature.findMany({
      where: { roleOwners: { some: { userId: user.id } } },
      orderBy: { title: 'asc' },
      include: {
        team: { select: { name: true, project: { select: { name: true } } } },
        roleOwners: { where: { userId: user.id }, select: { role: true } },
      },
    });
    return features.map((f) => ({
      id: f.id,
      title: f.title,
      teamName: f.team.name,
      projectName: f.team.project.name,
      myRoles: f.roleOwners.map((o) => o.role),
    }));
  }
}
