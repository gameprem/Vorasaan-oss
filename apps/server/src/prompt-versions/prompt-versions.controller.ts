import {
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  CreatePromptVersionInput,
  DeclinePromptVersionInput,
  PromptAnalysisSettingsInput,
  type PromptDetailView,
  PromptDiffQuery,
  PromptEvalCompareQuery,
  type PromptsView,
  RollbackPromptInput,
  StartPromptEvalInput,
} from '@vorasaan/shared';
import { readSkillSource, SKILLS, type SkillName, skillVersion } from '@vorasaan/skills';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser } from '../auth/identity.guard.ts';
import { casesForPrompt } from '../evals/eval-sets.ts';
import { PromptEvalsService } from './prompt-evals.service.ts';
import { PromptProposalsService } from './prompt-proposals.service.ts';
import { PromptVersionsService, tasksOf } from './prompt-versions.service.ts';
import { PromptReplay, REPLAYABLE } from './replay.ts';

/** Settings → AI → Prompts, as read: every prompt with its active version, or one in full. */
@Injectable()
export class PromptSettings {
  constructor(
    private readonly versions: PromptVersionsService,
    private readonly evals: PromptEvalsService,
    private readonly replay: PromptReplay,
    private readonly proposals: PromptProposalsService,
  ) {}

  async list(): Promise<PromptsView> {
    const [active, versions, newFeedback, analysisAfter] = await Promise.all([
      this.versions.activeByPrompt(),
      this.versions.versionsByPrompt(),
      this.proposals.newOutcomesByPrompt(SKILLS),
      this.proposals.analysisAfter(),
    ]);
    return {
      analysisAfter,
      prompts: await Promise.all(
        SKILLS.map(async (name) => {
          const held = versions.get(name) ?? [];
          return {
            name,
            tasks: tasksOf(name),
            active: active.get(name) ?? {
              number: 0,
              version: await skillVersion(name),
              since: null,
              by: null,
            },
            versions: held.length,
            proposed: held.filter((v) => v.status === 'PROPOSED').length,
            evalCases: casesForPrompt(name).length,
            replayable: Boolean(REPLAYABLE[name]),
            newFeedback: newFeedback.get(name) ?? 0,
          };
        }),
      ),
    };
  }

  async detail(name: SkillName): Promise<PromptDetailView> {
    const active = await this.versions.active(name);
    const sets = new Map<string, number>();
    for (const c of casesForPrompt(name)) sets.set(c.set, (sets.get(c.set) ?? 0) + 1);
    const [template, version, versions, history, runs, receipts, feedback] = await Promise.all([
      readSkillSource(name),
      skillVersion(name),
      this.versions.versionViews(name, active.number),
      this.versions.history(name),
      this.evals.runs(name),
      REPLAYABLE[name] ? this.replay.count(name) : 0,
      this.proposals.feedback(name),
    ]);
    return {
      name,
      tasks: tasksOf(name),
      default: { version, template },
      active,
      versions,
      history,
      evalSets: [...sets].map(([set, cases]) => ({ set, cases })),
      replay: { supported: Boolean(REPLAYABLE[name]), receipts },
      runs,
      feedback,
    };
  }
}

/**
 * Settings → AI → Prompts (ADR 0015, ticket 0071), Admins only: the prompts and their
 * Prompt Versions, writing, approving, declining and rolling back a version, the diff
 * between two, and eval runs with their comparison. Version 0 is the built-in default.
 */
@AdminOnly()
@Controller('settings/ai/prompts')
export class PromptVersionsController {
  constructor(
    private readonly settings: PromptSettings,
    private readonly versions: PromptVersionsService,
    private readonly evals: PromptEvalsService,
    private readonly proposals: PromptProposalsService,
  ) {}

  @Get()
  list() {
    return this.settings.list();
  }

  @Get(':name')
  detail(@Param('name') name: string) {
    return this.settings.detail(this.versions.prompt(name));
  }

  @Post(':name/versions')
  propose(
    @CurrentUser() user: User,
    @Param('name') name: string,
    @Body({ schema: CreatePromptVersionInput }) body: CreatePromptVersionInput,
  ) {
    return this.versions.propose(user, this.versions.prompt(name), body);
  }

  @Post(':name/versions/:number/approve')
  approve(
    @CurrentUser() user: User,
    @Param('name') name: string,
    @Param('number', ParseIntPipe) number: number,
  ) {
    return this.versions.approve(user, this.versions.prompt(name), number);
  }

  @Post(':name/versions/:number/decline')
  decline(
    @CurrentUser() user: User,
    @Param('name') name: string,
    @Param('number', ParseIntPipe) number: number,
    @Body({ schema: DeclinePromptVersionInput }) body: DeclinePromptVersionInput,
  ) {
    return this.versions.decline(user, this.versions.prompt(name), number, body.reason);
  }

  /** A Prompt Version the AI proposed, with its patterns, diff and evals (ticket 0072). */
  @Get(':name/versions/:number/proposal')
  proposal(@Param('name') name: string, @Param('number', ParseIntPipe) number: number) {
    return this.proposals.proposal(this.versions.prompt(name), number);
  }

  /** The AI reads the prompt's feedback now and, from its patterns, proposes a version (0072). */
  @Post(':name/analyses')
  analyze(@CurrentUser() user: User, @Param('name') name: string) {
    return this.proposals.analyze(user, this.versions.prompt(name), 'MANUAL');
  }

  @Post(':name/rollback')
  rollback(
    @CurrentUser() user: User,
    @Param('name') name: string,
    @Body({ schema: RollbackPromptInput }) body: RollbackPromptInput,
  ) {
    return this.versions.rollback(user, this.versions.prompt(name), body.version);
  }

  @Get(':name/diff')
  diff(@Param('name') name: string, @Query({ schema: PromptDiffQuery }) query: PromptDiffQuery) {
    return this.versions.diff(this.versions.prompt(name), query.from, query.to);
  }

  @Post(':name/evals')
  startEval(
    @CurrentUser() user: User,
    @Param('name') name: string,
    @Body({ schema: StartPromptEvalInput }) body: StartPromptEvalInput,
  ) {
    return this.evals.start(user, this.versions.prompt(name), body);
  }

  /** Before `:runId`, so "compare" is never read as a run's id. */
  @Get(':name/evals/compare')
  compare(
    @Param('name') name: string,
    @Query({ schema: PromptEvalCompareQuery }) query: PromptEvalCompareQuery,
  ) {
    return this.evals.compare(this.versions.prompt(name), query.a, query.b);
  }

  @Get(':name/evals/:runId')
  run(@Param('name') name: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.evals.run(this.versions.prompt(name), runId);
  }
}

/**
 * After how many new outcomes the AI reads a prompt's feedback on its own (ticket 0072),
 * Admins only. 0 turns that off; an Admin can still ask from a prompt's page.
 */
@AdminOnly()
@Controller('settings/ai/prompt-analysis')
export class PromptAnalysisSettingsController {
  constructor(private readonly proposals: PromptProposalsService) {}

  @Get()
  async get() {
    return { analysisAfter: await this.proposals.analysisAfter() };
  }

  @Put()
  set(@Body({ schema: PromptAnalysisSettingsInput }) body: PromptAnalysisSettingsInput) {
    return this.proposals.setAnalysisAfter(body.analysisAfter);
  }
}
