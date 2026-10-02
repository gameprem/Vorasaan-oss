import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { DecisionStatsQuery } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { DecisionStatsService } from './decision-stats.service.ts';

@Controller()
export class DecisionStatsController {
  constructor(private readonly stats: DecisionStatsService) {}

  /** Decision Lead Time, overdue requests and time waited; every member of the Organization reads them. */
  @Get('projects/:id/decision-stats')
  forProject(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: DecisionStatsQuery }) query: DecisionStatsQuery,
  ) {
    return this.stats.forProject(user, id, query);
  }
}
