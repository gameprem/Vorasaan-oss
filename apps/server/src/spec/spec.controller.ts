import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { CurrentUser } from '../auth/identity.guard.ts';
import { SpecService } from './spec.service.ts';

@Controller()
export class SpecController {
  constructor(private readonly spec: SpecService) {}

  @Get('spec-proposals/:id')
  getProposal(@Param('id', ParseUUIDPipe) id: string) {
    return this.spec.getProposal(id);
  }

  @Post('spec-proposals/:id/approve')
  approve(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.approve(user, id);
  }

  @Post('spec-proposals/:id/reject')
  reject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.spec.reject(user, id);
  }

  @Get('features/:id/spec-versions')
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.spec.listVersions(id);
  }

  @Get('features/:id/decision-log')
  decisionLog(@Param('id', ParseUUIDPipe) id: string) {
    return this.spec.decisionLog(id);
  }
}
