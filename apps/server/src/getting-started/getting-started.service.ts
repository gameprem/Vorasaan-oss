import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import {
  ChatLanguage,
  DEFAULT_CHAT_LANGUAGE,
  type GettingStartedItemKey,
  type GettingStartedView,
  type OrganizationSettingsInput,
  type OrganizationSettingsView,
} from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const CHAT_APP_INTEGRATIONS = ['LINE', 'SLACK', 'TEAMS'] as const;

/**
 * After first-run setup (ticket 0063): the Organization's default language, and the
 * Getting started checklist. Nothing on the checklist is ticked by hand: each item is
 * read from what exists, every time it is asked for.
 */
@Injectable()
export class GettingStartedService {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
  ) {}

  private async membershipOf(user: Pick<User, 'id'>) {
    const membership = await this.db.orgMembership.findFirst({
      where: { userId: user.id },
      include: { organization: { select: { name: true, language: true } } },
    });
    if (!membership) throw new ForbiddenException('You are not in an Organization');
    return membership;
  }

  // ─── Organization language ──────────────────────────────────────────────────

  async organizationSettings(user: User): Promise<OrganizationSettingsView> {
    const { organization } = await this.membershipOf(user);
    return {
      name: organization.name,
      language: ChatLanguage.catch(DEFAULT_CHAT_LANGUAGE).parse(organization.language),
    };
  }

  async saveOrganizationSettings(
    user: User,
    input: OrganizationSettingsInput,
  ): Promise<OrganizationSettingsView> {
    const { organizationId } = await this.membershipOf(user);
    await this.db.organization.update({
      where: { id: organizationId },
      data: { language: input.language },
    });
    return this.organizationSettings(user);
  }

  // ─── Getting started ────────────────────────────────────────────────────────

  async checklist(user: User): Promise<GettingStartedView> {
    const { organizationId, gettingStartedDismissedAt } = await this.membershipOf(user);
    const now = this.clock.now();
    const inOrg = { project: { organizationId } };
    const [teams, specs, members, usedTokens, chatApps] = await Promise.all([
      this.db.team.count({ where: inOrg }),
      this.db.specVersion.count({ where: { feature: { team: inOrg } } }),
      this.db.orgMembership.count({ where: { organizationId } }),
      this.db.personalAccessToken.count({
        where: {
          userId: user.id,
          revokedAt: null,
          lastUsedAt: { not: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      }),
      this.db.orgIntegration.count({
        where: { organizationId, provider: { in: [...CHAT_APP_INTEGRATIONS] } },
      }),
    ]);
    const items: GettingStartedView['items'] = (
      [
        ['PROJECT_AND_TEAM', teams > 0, false],
        ['FEATURE_WITH_SPEC', specs > 0, false],
        // People join only by accepting an invitation, so anyone besides the first Admin
        // means one was accepted.
        ['INVITE_MEMBERS', members > 1, false],
        ['LINK_CLI', usedTokens > 0, false],
        ['CHAT_APP', chatApps > 0, true],
      ] as [GettingStartedItemKey, boolean, boolean][]
    ).map(([key, done, optional]) => ({ key, done, optional }));
    return {
      items,
      complete: items.every((i) => i.done || i.optional),
      dismissed: gettingStartedDismissedAt !== null,
    };
  }

  async dismiss(user: User): Promise<GettingStartedView> {
    const { id } = await this.membershipOf(user);
    await this.db.orgMembership.update({
      where: { id },
      data: { gettingStartedDismissedAt: this.clock.now() },
    });
    return this.checklist(user);
  }
}
