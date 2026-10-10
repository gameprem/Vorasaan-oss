import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import type { DecisionGraphView } from '@vorasaan/shared';
import { CurrentUser } from '../auth/identity.guard.ts';
import { DecisionGraphService } from './decision-graph.service.ts';

@Controller('features')
export class DecisionGraphController {
  constructor(private readonly graph: DecisionGraphService) {}

  /** The Decision Graph (ticket 0067): Spec Versions and the Decision Requests between them. */
  @Get(':id/decision-graph')
  forFeature(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DecisionGraphView> {
    return this.graph.forFeature(user, id);
  }
}
