import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import { AttachmentFilesService } from '../attachments/attachment-files.service.ts';
import {
  featureInOrganizationOf,
  organizationAdministeredBy,
  organizationOf,
} from '../auth/organization-scope.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { NotificationsService } from '../inbox/notifications.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

type Tx = Prisma.TransactionClient;

/** Who to tell once the delete commits, read inside its transaction. */
type Audience = { inbox: string[]; members: string[] };

const OPEN_REQUEST = {
  status: { in: ['DRAFT', 'OPEN', 'NEEDS_INFO'] },
} satisfies Prisma.DecisionRequestWhereInput;

/**
 * Deleting a Feature or a Project (ticket 0049). The rows under it cascade in the database;
 * what only names it by a plain id is either removed here (chat cards for its Spec
 * Proposals) or kept on purpose (Receipts and their outcomes, for the Learning Loop and the
 * AI usage history). Stored Attachment files go through AttachmentFilesService, after the
 * delete commits. Then everyone whose Inbox may have changed hears `inbox.changed`, and every
 * member of the Organization with a stream open hears `feature.deleted` or `project.deleted`,
 * so a page showing it moves away.
 */
@Injectable()
export class DeletionService {
  private readonly logger = new Logger(DeletionService.name);

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly files: AttachmentFilesService,
    private readonly notifications: NotificationsService,
    private readonly bus: EventBus,
  ) {}

  /** `DELETE /features/:id`: the Feature's PO Role Owners and Admins. 404 outside the Organization. */
  async deleteFeature(user: User, featureId: string): Promise<void> {
    const feature = await this.db.feature.findFirst({
      where: { id: featureId, ...featureInOrganizationOf(user.id) },
      select: {
        title: true,
        team: {
          select: {
            projectId: true,
            project: {
              select: {
                organizationId: true,
                organization: {
                  select: { memberships: { where: { userId: user.id }, select: { role: true } } },
                },
              },
            },
          },
        },
        roleOwners: { where: { userId: user.id, role: 'PO' }, select: { id: true } },
      },
    });
    if (!feature) throw new NotFoundException('Feature not found');
    const admin = feature.team.project.organization.memberships.some((m) => m.role === 'ADMIN');
    if (!admin && feature.roleOwners.length === 0) {
      throw new ForbiddenException("Only an Admin or the Feature's PO can delete it");
    }

    const audience = await this.files.deleteFeature(featureId, async (tx) => {
      const audience = await this.audience(
        tx,
        { id: featureId },
        feature.team.project.organizationId,
      );
      await this.tidy(tx, { id: featureId });
      return audience;
    });
    await this.announce(audience, {
      event: 'feature.deleted',
      data: { featureId, projectId: feature.team.projectId, title: feature.title },
    });
  }

  /** `DELETE /projects/:id`: Admins of its Organization. 404 outside it. */
  async deleteProject(user: User, projectId: string): Promise<void> {
    const project = await this.db.project.findFirst({
      where: { id: projectId, organization: organizationOf(user.id) },
      select: { name: true, organizationId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const admin = await this.db.organization.count({
      where: { id: project.organizationId, ...organizationAdministeredBy(user.id) },
    });
    if (!admin) throw new ForbiddenException('Only an Organization Admin can delete a Project');

    const { audience, teamIds, featureIds } = await this.files.deleteProject(
      projectId,
      async (tx) => {
        const [teams, features] = await Promise.all([
          tx.team.findMany({ where: { projectId }, select: { id: true } }),
          tx.feature.findMany({ where: { team: { projectId } }, select: { id: true } }),
        ]);
        const inProject = { team: { projectId } } satisfies Prisma.FeatureWhereInput;
        const [audience, briefApprovers, grillers] = await Promise.all([
          this.audience(tx, inProject, project.organizationId),
          tx.briefProposal.findMany({
            where: { projectId, status: 'PENDING' },
            select: { approverId: true },
          }),
          tx.teamMembership.findMany({
            where: { team: { projectId } },
            select: { userId: true },
          }),
        ]);
        await this.tidy(tx, inProject);
        audience.inbox.push(
          ...briefApprovers.map((p) => p.approverId),
          ...grillers.map((m) => m.userId),
        );
        return {
          audience,
          teamIds: teams.map((t) => t.id).toSorted(),
          featureIds: features.map((f) => f.id).toSorted(),
        };
      },
    );
    await this.announce(audience, {
      event: 'project.deleted',
      data: { projectId, name: project.name, teamIds, featureIds },
    });
  }

  /**
   * Who may see a change: anyone with an Inbox Item or a Notification on the Features
   * (their Team, Role Owners, the people on their open Decision Requests and pending Spec
   * Proposals), and every member of the Organization for the page they may have open.
   */
  private async audience(
    tx: Tx,
    features: Prisma.FeatureWhereInput,
    organizationId: string,
  ): Promise<Audience> {
    const [team, owners, requests, recipients, proposals, notified, members] = await Promise.all([
      tx.teamMembership.findMany({
        where: { team: { features: { some: features } } },
        select: { userId: true },
      }),
      tx.roleOwner.findMany({ where: { feature: features }, select: { userId: true } }),
      tx.decisionRequest.findMany({
        where: { feature: features, ...OPEN_REQUEST },
        select: { raiserId: true, deciderId: true },
      }),
      tx.requestRecipient.findMany({
        where: { request: { feature: features, ...OPEN_REQUEST } },
        select: { userId: true },
      }),
      tx.specProposal.findMany({
        where: { feature: features, status: 'PENDING' },
        select: { approverId: true },
      }),
      tx.notification.findMany({
        where: { feature: features, readAt: null },
        distinct: ['userId'],
        select: { userId: true },
      }),
      tx.orgMembership.findMany({
        where: { organizationId },
        select: { userId: true },
      }),
    ]);
    return {
      inbox: [
        ...team.map((m) => m.userId),
        ...owners.map((o) => o.userId),
        ...requests.flatMap((r) => [r.raiserId, r.deciderId ?? '']),
        ...recipients.map((r) => r.userId),
        ...proposals.map((p) => p.approverId),
        ...notified.map((n) => n.userId),
      ].filter(Boolean),
      members: members.map((m) => m.userId),
    };
  }

  /**
   * Rows that name the Features' records by a plain id, not a foreign key, and mean nothing
   * without them: chat cards linking to a Spec Proposal (a Decision Request's cascade).
   */
  private async tidy(tx: Tx, features: Prisma.FeatureWhereInput): Promise<void> {
    const proposals = await tx.specProposal.findMany({
      where: { feature: features },
      select: { id: true },
    });
    if (!proposals.length) return;
    await tx.chatCard.deleteMany({
      where: { specProposalId: { in: proposals.map((p) => p.id) } },
    });
  }

  /** After the commit: Inbox Items first, then the pages showing what was deleted. */
  private async announce(
    audience: Audience,
    event:
      | { event: 'feature.deleted'; data: { featureId: string; projectId: string; title: string } }
      | {
          event: 'project.deleted';
          data: { projectId: string; name: string; teamIds: string[]; featureIds: string[] };
        },
  ): Promise<void> {
    await this.notifications.publish(this.notifications.outbox().inboxChanged(audience.inbox));
    try {
      for (const userId of new Set(audience.members)) this.bus.emit(userId, event);
    } catch (error) {
      this.logger.error('Could not push the delete', error as Error);
    }
  }
}
