import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.ts';
import { AgentSkillsController } from './agent-skills.controller.ts';
import { AgentSkillsService } from './agent-skills.service.ts';
import { AGENT_SKILL_FETCH, type HttpFetch } from './github-source.ts';

/** Agent Skills (ADR 0017, ticket 0078): installs, approvals, and the AI's read-only tools. */
@Module({
  imports: [StorageModule],
  controllers: [AgentSkillsController],
  providers: [
    AgentSkillsService,
    // GitHub is fetched with the platform's fetch; tests give a fake GitHub server.
    { provide: AGENT_SKILL_FETCH, useValue: ((url, init) => fetch(url, init)) satisfies HttpFetch },
  ],
  exports: [AgentSkillsService],
})
export class AgentSkillsModule {}
