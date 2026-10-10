import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  type ActivePromptView,
  type CreatePromptVersionInput,
  DEFAULT_PROMPT_NUMBER,
  diffLines,
  type PromptActivationView,
  type PromptDiff,
  type PromptVersionView,
} from '@vorasaan/shared';
import {
  expandPartials,
  isSkillName,
  loadSkill,
  placeholdersOf,
  promptVersionOf,
  readSkillSource,
  type SkillName,
  skillVersion,
} from '@vorasaan/skills';
import type { AiTask } from '../ai/ai.config.ts';
import type { PromptChoice } from '../ai/ai.port.ts';
import { TASK_SKILLS } from '../ai/prompts.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ReceiptsService } from '../receipts/receipts.service.ts';
import { assertNotRedrafting } from '../redrafts/redraft-guard.ts';

const person = { select: { id: true, name: true } } as const;

export const versionInclude = {
  proposedBy: person,
  approvedBy: person,
  declinedBy: person,
} as const satisfies Prisma.PromptVersionInclude;

export type VersionRow = Prisma.PromptVersionGetPayload<{ include: typeof versionInclude }>;

/** The placeholder that only marks the cacheable prefix (0061): a version may drop it. */
const OPTIONAL_PLACEHOLDERS = new Set(['cacheBreak']);

/** The AI tasks that render each prompt, in AI_TASKS order. */
export function tasksOf(name: SkillName): AiTask[] {
  return (Object.keys(TASK_SKILLS) as AiTask[]).filter((task) => TASK_SKILLS[task] === name);
}

/**
 * Prompt Versions (ADR 0015, ticket 0071): an Organization's own versions of the prompts
 * in packages/skills, which stay the defaults. A version is numbered when written, never
 * changes, and is a proposal until an Admin approves it; approving makes it active. The
 * active version of a prompt is its latest PromptActivation (none: the default), so a
 * rollback is recorded like an approval. Every AI call asks `choose` which to render.
 */
@Injectable()
export class PromptVersionsService {
  /**
   * Versions as Receipts name them, by id and template: a decided version never changes; a
   * proposal the AI made changes only by its Redrafts (ticket 0072), and is named anew.
   */
  private readonly names = new Map<string, { template: string; name: Promise<string> }>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
    private readonly receipts: ReceiptsService,
  ) {}

  // ─── Choosing (every AI call) ─────────────────────────────────────────────

  /** The version of the task's prompt to render: the active Prompt Version, else the default. */
  async choose(task: AiTask): Promise<PromptChoice> {
    const name = TASK_SKILLS[task];
    const organizationId = await this.organizationId();
    if (!organizationId) return this.defaultChoice(name);
    const latest = await this.db.promptActivation.findFirst({
      where: { organizationId, promptName: name },
      orderBy: { seq: 'desc' },
      select: { version: { select: { id: true, number: true, template: true } } },
    });
    return latest?.version ? this.choiceOf(name, latest.version) : this.defaultChoice(name);
  }

  /** A given version of a prompt, whatever its status (an eval run evaluates proposals too). */
  async resolve(name: SkillName, number: number): Promise<PromptChoice> {
    if (number === DEFAULT_PROMPT_NUMBER) return this.defaultChoice(name);
    const row = await this.findVersion(name, number);
    return this.choiceOf(name, row);
  }

  private async defaultChoice(name: SkillName): Promise<PromptChoice> {
    return { name, version: await skillVersion(name), number: 0, template: null };
  }

  private async choiceOf(
    name: SkillName,
    row: { id: string; number: number; template: string },
  ): Promise<PromptChoice> {
    return {
      name,
      version: await this.versionName(row),
      number: row.number,
      template: row.template,
    };
  }

  versionName(row: { id: string; number: number; template: string }): Promise<string> {
    let named = this.names.get(row.id);
    if (named?.template !== row.template) {
      named = { template: row.template, name: promptVersionOf(row.number, row.template) };
      this.names.set(row.id, named);
    }
    return named.name;
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /** A prompt name from a URL: one of the built-in prompts, or 404. */
  prompt(name: string): SkillName {
    if (!isSkillName(name)) throw new NotFoundException(`No prompt is called "${name}"`);
    return name;
  }

  async organizationId(): Promise<string | null> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return org?.id ?? null;
  }

  private async requireOrganization(): Promise<string> {
    const id = await this.organizationId();
    if (!id) throw new UnprocessableEntityException('Run setup first');
    return id;
  }

  /** Every Prompt Version of the Organization, newest first, grouped by prompt. */
  async versionsByPrompt(): Promise<Map<string, VersionRow[]>> {
    const organizationId = await this.organizationId();
    const rows = organizationId
      ? await this.db.promptVersion.findMany({
          where: { organizationId },
          orderBy: [{ promptName: 'asc' }, { number: 'desc' }],
          include: versionInclude,
        })
      : [];
    const byPrompt = new Map<string, VersionRow[]>();
    for (const row of rows)
      byPrompt.set(row.promptName, [...(byPrompt.get(row.promptName) ?? []), row]);
    return byPrompt;
  }

  /** The active version of every prompt: the latest activation of each, by prompt. */
  async activeByPrompt(): Promise<Map<string, ActivePromptView>> {
    const organizationId = await this.organizationId();
    const rows = organizationId
      ? await this.db.promptActivation.findMany({
          where: { organizationId },
          orderBy: { seq: 'desc' },
          distinct: ['promptName'],
          include: {
            actor: person,
            version: { select: { id: true, number: true, template: true } },
          },
        })
      : [];
    const active = new Map<string, ActivePromptView>();
    for (const row of rows) {
      const name = row.promptName as SkillName;
      active.set(row.promptName, {
        number: row.version?.number ?? DEFAULT_PROMPT_NUMBER,
        version: row.version ? await this.versionName(row.version) : await skillVersion(name),
        since: row.createdAt.toISOString(),
        by: row.actor,
      });
    }
    return active;
  }

  /** The active version of one prompt. */
  async active(name: SkillName): Promise<ActivePromptView> {
    return (
      (await this.activeByPrompt()).get(name) ?? {
        number: DEFAULT_PROMPT_NUMBER,
        version: await skillVersion(name),
        since: null,
        by: null,
      }
    );
  }

  /** A prompt's versions (newest first) as views, marking the active one. */
  async versionViews(name: SkillName, activeNumber: number): Promise<PromptVersionView[]> {
    const rows = (await this.versionsByPrompt()).get(name) ?? [];
    return Promise.all(rows.map((row) => this.view(row, activeNumber)));
  }

  /** Every approval and rollback of a prompt, newest first. */
  async history(name: SkillName): Promise<PromptActivationView[]> {
    const organizationId = await this.organizationId();
    if (!organizationId) return [];
    const rows = await this.db.promptActivation.findMany({
      where: { organizationId, promptName: name },
      orderBy: { seq: 'desc' },
      include: { actor: person, version: { select: { number: true } } },
    });
    return rows.map((row) => ({
      number: row.version?.number ?? DEFAULT_PROMPT_NUMBER,
      kind: row.kind,
      by: row.actor,
      at: row.createdAt.toISOString(),
    }));
  }

  async view(row: VersionRow, activeNumber: number): Promise<PromptVersionView> {
    return {
      id: row.id,
      number: row.number,
      version: await this.versionName(row),
      status: row.status,
      template: row.template,
      note: row.note,
      proposedBy: row.proposedBy,
      createdAt: row.createdAt.toISOString(),
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      declinedBy: row.declinedBy,
      declinedAt: row.declinedAt?.toISOString() ?? null,
      declineReason: row.declineReason,
      active: row.number === activeNumber,
      analysisId: row.analysisId,
      rationale: row.rationale,
    };
  }

  async findVersion(name: SkillName, number: number): Promise<VersionRow> {
    const organizationId = await this.organizationId();
    const row = organizationId
      ? await this.db.promptVersion.findUnique({
          where: { organizationId_promptName_number: { organizationId, promptName: name, number } },
          include: versionInclude,
        })
      : null;
    if (!row) throw new NotFoundException(`${name} has no Prompt Version ${number}`);
    return row;
  }

  /** The template of a version as written; the default's is its packages/skills source. */
  async template(name: SkillName, number: number): Promise<string> {
    if (number === DEFAULT_PROMPT_NUMBER) return readSkillSource(name);
    return (await this.findVersion(name, number)).template;
  }

  /** A line diff of two versions of a prompt (0 is the default), like a Spec Version diff. */
  async diff(name: SkillName, from: number, to: number): Promise<PromptDiff> {
    const [before, after] = await Promise.all([this.template(name, from), this.template(name, to)]);
    const lines = diffLines(before, after);
    return {
      from,
      to,
      added: lines.filter((l) => l.kind === 'ADDED').length,
      removed: lines.filter((l) => l.kind === 'REMOVED').length,
      lines,
    };
  }

  // ─── Writing ──────────────────────────────────────────────────────────────

  /**
   * A Prompt Version written by hand: numbered next, PROPOSED until an Admin approves it.
   * Its template must render: only partials that exist, and exactly the values the
   * prompt is given (the cache break may be left out).
   */
  async propose(
    user: User,
    name: SkillName,
    input: CreatePromptVersionInput,
  ): Promise<PromptVersionView> {
    const organizationId = await this.requireOrganization();
    await this.assertRenders(name, input.template);
    for (let attempt = 0; ; attempt++) {
      const last = await this.db.promptVersion.findFirst({
        where: { organizationId, promptName: name },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      try {
        const row = await this.db.promptVersion.create({
          data: {
            organizationId,
            promptName: name,
            number: (last?.number ?? 0) + 1,
            template: input.template,
            note: input.note?.trim() || null,
            proposedById: user.id,
            createdAt: this.clock.now(),
          },
          include: versionInclude,
        });
        return this.view(row, (await this.active(name)).number);
      } catch (error) {
        // Two written at once took the same number: take the next one.
        const code = (error as { code?: string })?.code;
        if (code !== 'P2002' || attempt >= 2) throw error;
      }
    }
  }

  /** The placeholders a version of the prompt must keep: all it is given but the cache break. */
  async requiredPlaceholders(name: SkillName): Promise<string[]> {
    return placeholdersOf(await loadSkill(name)).filter((p) => !OPTIONAL_PLACEHOLDERS.has(p));
  }

  /** 422 unless the template renders as a version of the prompt (see `propose`). */
  async assertRenders(name: SkillName, template: string): Promise<void> {
    let expanded: string;
    try {
      expanded = await expandPartials(template);
    } catch (error) {
      throw new UnprocessableEntityException((error as Error).message);
    }
    const given = placeholdersOf(await loadSkill(name));
    const used = placeholdersOf(expanded);
    const unknown = used.filter((p) => !given.includes(p));
    if (unknown.length) {
      throw new UnprocessableEntityException(
        `This prompt is not given ${unknown.map((p) => `{{${p}}}`).join(', ')}. It is given: ${given
          .map((p) => `{{${p}}}`)
          .join(', ')}`,
      );
    }
    const missing = given.filter((p) => !used.includes(p) && !OPTIONAL_PLACEHOLDERS.has(p));
    if (missing.length) {
      throw new UnprocessableEntityException(
        `Keep ${missing.map((p) => `{{${p}}}`).join(', ')}: without it the AI never sees that input`,
      );
    }
  }

  /**
   * Approves a proposed version and makes it active. One the AI proposed (ticket 0072) waits
   * for a Redraft being written, like every AI proposal (ADR 0013).
   */
  async approve(user: User, name: SkillName, number: number): Promise<PromptVersionView> {
    const row = await this.findVersion(name, number);
    if (row.status !== 'PROPOSED') {
      throw new ConflictException(`v${number} is already ${row.status.toLowerCase()}`);
    }
    if (row.analysisId) await assertNotRedrafting(this.db, 'PROMPT_VERSION', row.id);
    const now = this.clock.now();
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.promptVersion.updateMany({
        where: { id: row.id, status: 'PROPOSED' },
        data: { status: 'APPROVED', approvedById: user.id, approvedAt: now },
      });
      if (!count) throw new ConflictException(`v${number} was decided meanwhile`);
      await tx.promptActivation.create({
        data: {
          organizationId: row.organizationId,
          promptName: name,
          versionId: row.id,
          kind: 'APPROVE',
          actorId: user.id,
          createdAt: now,
        },
      });
    });
    if (row.analysisId) {
      this.receipts.outcome({
        kind: 'APPROVE',
        proposal: { kind: 'PROMPT_VERSION', id: row.id },
        actorId: user.id,
      });
    }
    return this.view(await this.findVersion(name, number), number);
  }

  async decline(
    user: User,
    name: SkillName,
    number: number,
    reason?: string,
  ): Promise<PromptVersionView> {
    const row = await this.findVersion(name, number);
    if (row.status !== 'PROPOSED') {
      throw new ConflictException(`v${number} is already ${row.status.toLowerCase()}`);
    }
    // The AI learns from why its proposal was declined (ticket 0072): it takes a reason.
    if (row.analysisId && !reason?.trim()) {
      throw new UnprocessableEntityException('Say why you decline what the AI proposed');
    }
    const { count } = await this.db.promptVersion.updateMany({
      where: { id: row.id, status: 'PROPOSED' },
      data: {
        status: 'DECLINED',
        declinedById: user.id,
        declinedAt: this.clock.now(),
        declineReason: reason?.trim() || null,
      },
    });
    if (!count) throw new ConflictException(`v${number} was decided meanwhile`);
    if (row.analysisId) {
      this.receipts.outcome({
        kind: 'DECLINE',
        proposal: { kind: 'PROMPT_VERSION', id: row.id },
        actorId: user.id,
        reason,
      });
    }
    return this.view(await this.findVersion(name, number), (await this.active(name)).number);
  }

  /**
   * Makes an earlier approved version (or 0, the default) active again, recorded as a
   * rollback. The next call renders it.
   */
  async rollback(user: User, name: SkillName, number: number): Promise<ActivePromptView> {
    const organizationId = await this.requireOrganization();
    const active = await this.active(name);
    if (active.number === number) throw new ConflictException('That version is already active');
    let versionId: string | null = null;
    if (number !== DEFAULT_PROMPT_NUMBER) {
      const row = await this.findVersion(name, number);
      if (row.status !== 'APPROVED') {
        throw new ConflictException(
          `Only an approved version can be made active; v${number} is ${row.status.toLowerCase()}`,
        );
      }
      versionId = row.id;
    }
    await this.db.promptActivation.create({
      data: {
        organizationId,
        promptName: name,
        versionId,
        kind: 'ROLLBACK',
        actorId: user.id,
        createdAt: this.clock.now(),
      },
    });
    return this.active(name);
  }
}
