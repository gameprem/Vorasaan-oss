import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DecisionRequestKind, Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  DEFAULT_RESPONSE_WINDOW_SETTINGS,
  minutesOfDay,
  type ProjectResponseWindowsInput,
  type ProjectResponseWindowsView,
  type ResponseWindow,
  type ResponseWindowSettingsInput,
  type ResponseWindowSettingsView,
  timeOfDay,
} from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import type { WorkingCalendar } from './working-time.ts';

type Db = PrismaClient | Prisma.TransactionClient;

/** The Response Window a Project gives a kind of request, and the calendar it is counted in. */
export type WindowPolicy = { calendar: WorkingCalendar; window: ResponseWindow };

export function toCalendar(s: ResponseWindowSettingsView): WorkingCalendar {
  return {
    timeZone: s.timeZone,
    workingDays: new Set(s.workingDays),
    startMinute: minutesOfDay(s.workStart),
    endMinute: minutesOfDay(s.workEnd),
    holidays: new Set(s.holidays.map((h) => h.date)),
  };
}

const window = (
  value: number | null,
  unit: ResponseWindow['unit'] | null,
): ResponseWindow | null => (value !== null && unit !== null ? { value, unit } : null);

/**
 * Response Windows (ADR 0011, ticket 0055): the Organization's working calendar and
 * default windows, which a Project may override per kind of Decision Request.
 * Everyone in the Organization reads them; only Admins change them (the controller).
 */
@Injectable()
export class ResponseWindowsService {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  async getSettings(user: User): Promise<ResponseWindowSettingsView> {
    return this.settings(this.db, await this.organizationIdOf(user));
  }

  async replaceSettings(
    user: User,
    input: ResponseWindowSettingsInput,
  ): Promise<ResponseWindowSettingsView> {
    const organizationId = await this.organizationIdOf(user);
    return this.db.$transaction(async (tx) => {
      const data = {
        timeZone: input.timeZone,
        workingDays: [...input.workingDays].sort((a, b) => a - b),
        workStartMinute: minutesOfDay(input.workStart),
        workEndMinute: minutesOfDay(input.workEnd),
        blockerWindow: input.blocker.value,
        blockerWindowUnit: input.blocker.unit,
        questionWindow: input.question.value,
        questionWindowUnit: input.question.unit,
      };
      await tx.responseWindowSettings.upsert({
        where: { organizationId },
        create: { organizationId, ...data },
        update: data,
      });
      await tx.orgHoliday.deleteMany({ where: { organizationId } });
      await tx.orgHoliday.createMany({
        data: input.holidays.map((h) => ({
          organizationId,
          date: new Date(`${h.date}T00:00:00Z`),
          name: h.name,
        })),
      });
      return this.settings(tx, organizationId);
    });
  }

  async getProject(user: User, projectId: string): Promise<ProjectResponseWindowsView> {
    const organizationId = await this.organizationIdOf(user);
    const project = await this.db.project.findFirst({ where: { id: projectId, organizationId } });
    if (!project) throw new NotFoundException('Project not found');
    return this.projectView(project, await this.settings(this.db, organizationId));
  }

  async replaceProject(
    user: User,
    projectId: string,
    input: ProjectResponseWindowsInput,
  ): Promise<ProjectResponseWindowsView> {
    const organizationId = await this.organizationIdOf(user);
    const { count } = await this.db.project.updateMany({
      where: { id: projectId, organizationId },
      data: {
        blockerWindow: input.blocker?.value ?? null,
        blockerWindowUnit: input.blocker?.unit ?? null,
        questionWindow: input.question?.value ?? null,
        questionWindowUnit: input.question?.unit ?? null,
      },
    });
    if (!count) throw new NotFoundException('Project not found');
    return this.getProject(user, projectId);
  }

  /** The window a request of `kind` on this Feature gets by default, and its calendar. */
  async forFeature(db: Db, featureId: string, kind: DecisionRequestKind): Promise<WindowPolicy> {
    const feature = await db.feature.findUniqueOrThrow({
      where: { id: featureId },
      select: { team: { select: { project: true } } },
    });
    const project = feature.team.project;
    const settings = await this.settings(db, project.organizationId);
    const { effective } = this.projectView(project, settings);
    return {
      calendar: toCalendar(settings),
      window: kind === 'BLOCKER' ? effective.blocker : effective.question,
    };
  }

  /** The Organization's calendar, for counting working time. */
  async calendar(db: Db, organizationId: string): Promise<WorkingCalendar> {
    return toCalendar(await this.settings(db, organizationId));
  }

  private async settings(db: Db, organizationId: string): Promise<ResponseWindowSettingsView> {
    // One after the other: `db` may be a transaction, which runs one query at a time.
    const row = await db.responseWindowSettings.findUnique({ where: { organizationId } });
    const holidays = await db.orgHoliday.findMany({
      where: { organizationId },
      orderBy: { date: 'asc' },
    });
    const base = row
      ? {
          timeZone: row.timeZone,
          workingDays: row.workingDays,
          workStart: timeOfDay(row.workStartMinute),
          workEnd: timeOfDay(row.workEndMinute),
          blocker: { value: row.blockerWindow, unit: row.blockerWindowUnit },
          question: { value: row.questionWindow, unit: row.questionWindowUnit },
        }
      : {
          ...DEFAULT_RESPONSE_WINDOW_SETTINGS,
          workingDays: [...DEFAULT_RESPONSE_WINDOW_SETTINGS.workingDays],
          blocker: { ...DEFAULT_RESPONSE_WINDOW_SETTINGS.blocker },
          question: { ...DEFAULT_RESPONSE_WINDOW_SETTINGS.question },
        };
    return {
      organizationId,
      ...base,
      holidays: holidays.map((h) => ({ date: h.date.toISOString().slice(0, 10), name: h.name })),
    };
  }

  private projectView(
    project: {
      id: string;
      blockerWindow: number | null;
      blockerWindowUnit: ResponseWindow['unit'] | null;
      questionWindow: number | null;
      questionWindowUnit: ResponseWindow['unit'] | null;
    },
    settings: ResponseWindowSettingsView,
  ): ProjectResponseWindowsView {
    const override = {
      blocker: window(project.blockerWindow, project.blockerWindowUnit),
      question: window(project.questionWindow, project.questionWindowUnit),
    };
    return {
      projectId: project.id,
      override,
      effective: {
        blocker: override.blocker ?? settings.blocker,
        question: override.question ?? settings.question,
      },
    };
  }

  private async organizationIdOf(user: User): Promise<string> {
    const membership = await this.db.orgMembership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    if (!membership) throw new ForbiddenException('You are not a member of an Organization');
    return membership.organizationId;
  }
}
