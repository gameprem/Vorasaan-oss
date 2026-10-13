import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import type { CreateDelegationInput, DelegationView, MyDelegationsQuery } from '@vorasaan/shared';
import { assertTeamInOrganization, teamInOrganizationOf } from '../auth/organization-scope.ts';
import { NotificationsService } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const person = { select: { id: true, name: true } } as const;
const delegationInclude = {
  delegator: person,
  delegate: person,
  createdBy: person,
} satisfies Prisma.DelegationInclude;
type DelegationWithPeople = Prisma.DelegationGetPayload<{ include: typeof delegationInclude }>;

/**
 * Delegations of a Team Role in a Team. Anyone in the Organization can see a Team's
 * Delegations (as with the Team itself: they explain where requests go); only the
 * delegator or an Org Admin can create or delete one. There is no edit: delete and
 * create again.
 */
@Injectable()
export class DelegationsService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly notifications: NotificationsService,
  ) {}

  /** Current and upcoming Delegations; ended ones are left out. */
  async list(user: User, teamId: string): Promise<DelegationView[]> {
    await assertTeamInOrganization(this.db, user.id, teamId);
    const now = new Date();
    const rows = await this.db.delegation.findMany({
      where: { teamId, endsAt: { gt: now } },
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
      include: delegationInclude,
    });
    const admin = await this.isAdmin(user.id);
    return rows.map((d) => toView(d, user, admin, now));
  }

  /** The caller's own current and upcoming Delegations, across every Team. */
  async mine(user: User, query: MyDelegationsQuery): Promise<DelegationView[]> {
    const now = new Date();
    const rows = await this.db.delegation.findMany({
      where: {
        ...(query.as === 'delegate' ? { delegateId: user.id } : { delegatorId: user.id }),
        endsAt: { gt: now },
        ...(query.active === 'true' ? { startsAt: { lte: now } } : {}),
      },
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
      include: delegationInclude,
    });
    const admin = await this.isAdmin(user.id);
    return rows.map((d) => toView(d, user, admin, now));
  }

  async create(user: User, teamId: string, input: CreateDelegationInput): Promise<DelegationView> {
    await assertTeamInOrganization(this.db, user.id, teamId);
    const admin = await this.isAdmin(user.id);
    const delegatorId = input.delegatorId ?? user.id;
    if (delegatorId !== user.id && !admin) {
      throw new ForbiddenException(
        'Only an Organization Admin can name a Delegate for someone else',
      );
    }
    if (input.delegateId === delegatorId) {
      throw new UnprocessableEntityException('The Delegate must be someone else');
    }
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const now = new Date();
    if (endsAt <= now) {
      throw new UnprocessableEntityException('This Delegation would already be over');
    }

    const holders = await this.db.teamMembership.findMany({
      where: { teamId, role: input.role, userId: { in: [delegatorId, input.delegateId] } },
      select: { userId: true },
    });
    const holds = (id: string) => holders.some((h) => h.userId === id);
    if (!holds(delegatorId)) {
      throw new UnprocessableEntityException(
        `Only someone holding the ${input.role} Team Role in this Team can delegate it`,
      );
    }
    if (!holds(input.delegateId)) {
      throw new UnprocessableEntityException(
        `The Delegate must hold the ${input.role} Team Role in this Team`,
      );
    }

    const overlapping = await this.db.delegation.count({
      where: {
        teamId,
        role: input.role,
        delegatorId,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    if (overlapping) {
      throw new ConflictException(
        `There is already a Delegation for this ${input.role} Team Role in that period`,
      );
    }

    const outbox = this.notifications.outbox();
    const created = await this.db.$transaction(async (tx) => {
      const created = await tx.delegation.create({
        data: {
          teamId,
          role: input.role,
          delegatorId,
          delegateId: input.delegateId,
          startsAt,
          endsAt,
          createdById: user.id,
        },
        include: delegationInclude,
      });
      // One that starts later is announced once it has started (NotificationsService.startDelegations).
      if (startsAt <= now) {
        await this.notifications.notify(tx, outbox, {
          type: 'DELEGATION_STARTED',
          to: [created.delegateId],
          actorId: user.id,
          delegationId: created.id,
        });
      }
      return created;
    });
    await this.notifications.publish(outbox);
    return toView(created, user, admin, now);
  }

  async delete(user: User, teamId: string, id: string): Promise<void> {
    const delegation = await this.db.delegation.findFirst({
      where: { id, teamId, team: teamInOrganizationOf(user.id) },
    });
    if (!delegation) throw new NotFoundException('Delegation not found');
    if (delegation.delegatorId !== user.id && !(await this.isAdmin(user.id))) {
      throw new ForbiddenException('Only the delegator or an Organization Admin can delete it');
    }
    await this.db.delegation.deleteMany({ where: { id } });
  }

  private async isAdmin(userId: string) {
    return (await this.db.orgMembership.count({ where: { userId, role: 'ADMIN' } })) > 0;
  }
}

function toView(d: DelegationWithPeople, user: User, admin: boolean, now: Date): DelegationView {
  return {
    id: d.id,
    teamId: d.teamId,
    role: d.role,
    delegator: d.delegator,
    delegate: d.delegate,
    startsAt: d.startsAt.toISOString(),
    endsAt: d.endsAt.toISOString(),
    createdBy: d.createdBy,
    active: d.startsAt <= now && now < d.endsAt,
    canDelete: admin || d.delegatorId === user.id,
  };
}
