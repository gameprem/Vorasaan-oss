import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ActionCardKind, PrismaClient, User } from '@vorasaan/db';
import type {
  ActionCardDetail,
  ActionCardView,
  ApproveActionCardInput,
  DeclineActionCardInput,
} from '@vorasaan/shared';
import type { z } from 'zod';
import type { ChatTool, ChatToolCall } from '../ai/ai.port.ts';
import { BriefService } from '../brief/brief.service.ts';
import { projectAccess } from '../brief/brief-access.ts';
import { DecisionRequestsService } from '../decision-requests/decision-requests.service.ts';
import { FeatureSuggestionsService } from '../feature-suggestions/feature-suggestions.service.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { CONTEXT_BUDGET, ContextRetriever } from '../retrieval/context-retriever.ts';
import { SpecService } from '../spec/spec.service.ts';
import { type ActionCardRow, toActionCardView } from './action-card.view.ts';
import {
  chatToolsFor,
  DEFAULT_CHAT_SUGGESTIONS,
  DraftDecisionRequestArgs,
  DraftProposalArgs,
  SearchContextArgs,
  SuggestFeaturesArgs,
} from './chat-tools.ts';

/** What a tool runs against: the Conversation it was called in. */
export type ToolScope = {
  id: string;
  projectId: string;
  featureId: string | null;
  project: { name: string };
  feature: { title: string } | null;
};

/** A tool's result for the AI (a JSON text) and the Action Cards it made. */
export type ToolRun = { content: string; cards: ActionCardView[] };

type CardDraft = { kind: ActionCardKind; targetId: string; title: string; summary: string | null };

/** The dismiss reason when a Feature Suggestion card is declined without one. */
export const DEFAULT_DECLINE_REASON = 'Declined in a Conversation';

const SUMMARY_CHARS = 500;

/**
 * Action Cards (ADR 0008, ticket 0043): runs the tools the AI calls in a
 * Conversation, and approves or declines the cards they make.
 *
 * A tool only drafts, through the same service and permission check the forms
 * use (a DRAFT Decision Request, a PENDING Spec Proposal, Brief Proposal or
 * Feature Suggestion), or reads the Conversation's scope. A call the person may
 * not make is refused, and the refusal is the tool's result for the AI.
 *
 * Approving or declining a card calls the target's own service in the owner's
 * name: send or withdraw the draft, approve or reject the proposal, accept or
 * dismiss the suggestion. Nothing here reimplements their permissions, the
 * Decision Request state machine or the Inbox. A card whose target changed
 * elsewhere becomes STALE. Only the Conversation's owner sees or acts on a card;
 * anyone else gets 404.
 */
@Injectable()
export class ActionCardsService {
  private readonly logger = new Logger(ActionCardsService.name);
  /** Cards being approved or declined in this process (one server process per Organization). */
  private readonly acting = new Set<string>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly retriever: ContextRetriever,
    private readonly decisionRequests: DecisionRequestsService,
    private readonly spec: SpecService,
    private readonly brief: BriefService,
    private readonly suggestions: FeatureSuggestionsService,
    private readonly bus: EventBus,
  ) {}

  /** The tools offered in a Conversation of this scope. */
  toolsFor(scope: { featureId: string | null }): ChatTool[] {
    return chatToolsFor(scope);
  }

  // ─── Running a tool ───────────────────────────────────────────────────────

  /**
   * Runs one offered tool call for the Conversation's owner. `messageId` is the
   * stored ASSISTANT message that called it; its cards point there. Never
   * throws: a refusal or failure becomes the result the AI reads.
   */
  async run(
    user: User,
    conversation: ToolScope,
    messageId: string,
    call: ChatToolCall,
  ): Promise<ToolRun> {
    const tool = this.toolsFor(conversation).find((t) => t.name === call.name);
    if (!tool) return refusal(`There is no tool named "${call.name}" here`);
    const parsed = tool.inputSchema.safeParse(call.args ?? {});
    if (!parsed.success) return refusal(`Invalid arguments: ${describeIssues(parsed.error)}`);
    try {
      const drafts = await this.execute(user, conversation, call.name, parsed.data);
      if (!Array.isArray(drafts)) return { content: JSON.stringify(drafts), cards: [] };
      const cards = await this.createCards(conversation.id, messageId, call.id, drafts);
      return {
        content: JSON.stringify({
          ok: true,
          actionCards: cards.map((c) => ({ id: c.id, kind: c.kind, title: c.title })),
          note:
            'Drafted only. Each appears to the person as an Action Card; nothing changes until ' +
            'they approve it. Do not say it was approved, sent or saved.',
        }),
        cards,
      };
    } catch (error) {
      if (error instanceof HttpException) return refusal(error.message);
      this.logger.error(`The tool "${call.name}" failed`, error as Error);
      return refusal('The tool failed unexpectedly, so nothing was drafted');
    }
  }

  /** Runs the tool: the drafts to make cards for, or a read-only result. */
  private async execute(
    user: User,
    scope: ToolScope,
    name: string,
    args: unknown,
  ): Promise<CardDraft[] | { ok: true; results: unknown[] }> {
    switch (name) {
      case 'searchContext': {
        const { query } = args as z.infer<typeof SearchContextArgs>;
        const blocks = scope.featureId
          ? await this.retriever.forFeature(scope.featureId, query, CONTEXT_BUDGET.searchContext)
          : await this.retriever.forProject(scope.projectId, query, CONTEXT_BUDGET.searchContext);
        return {
          ok: true,
          results: blocks.map((b) => ({
            kind: b.source.kind,
            title: b.source.title,
            ...(b.source.version === undefined ? {} : { version: b.source.version }),
            scope: b.scope,
            text: b.text,
          })),
        };
      }
      case 'draftDecisionRequest': {
        const input = args as z.infer<typeof DraftDecisionRequestArgs>;
        const featureId = requireFeature(scope);
        const request = await this.decisionRequests.raise(user, { featureId, ...input });
        return [
          {
            kind: 'DECISION_REQUEST',
            targetId: request.id,
            title: request.title,
            summary: clip(request.description),
          },
        ];
      }
      case 'draftSpecProposal': {
        const input = args as z.infer<typeof DraftProposalArgs>;
        const featureId = requireFeature(scope);
        const proposal = await this.spec.proposeFromConversation(user, featureId, input);
        return [
          {
            kind: 'SPEC_PROPOSAL',
            targetId: proposal.id,
            title: `Change the Spec of "${scope.feature?.title ?? ''}"`,
            summary: input.summary,
          },
        ];
      }
      case 'draftBriefProposal': {
        const input = args as z.infer<typeof DraftProposalArgs>;
        const proposal = await this.brief.proposeFromConversation(user, scope.projectId, input);
        return [
          {
            kind: 'BRIEF_PROPOSAL',
            targetId: proposal.id,
            title: `Change the Project Brief of "${scope.project.name}"`,
            summary: input.summary,
          },
        ];
      }
      case 'suggestFeatures': {
        const { count } = args as z.infer<typeof SuggestFeaturesArgs>;
        const suggestions = await this.suggestions.generate(user, scope.projectId, {
          count: count ?? DEFAULT_CHAT_SUGGESTIONS,
        });
        return suggestions.map((s) => ({
          kind: 'FEATURE_SUGGESTION',
          targetId: s.id,
          title: s.title,
          summary: clip(s.rationale),
        }));
      }
      default:
        throw new UnprocessableEntityException(`There is no tool named "${name}" here`);
    }
  }

  private async createCards(
    conversationId: string,
    messageId: string,
    toolCallId: string,
    drafts: CardDraft[],
  ): Promise<ActionCardView[]> {
    const now = Date.now();
    const rows = await this.db.$transaction(
      drafts.map((d, i) =>
        this.db.actionCard.create({
          // Keeps the tool's order in `createdAt` listings.
          data: { conversationId, messageId, toolCallId, ...d, createdAt: new Date(now + i) },
        }),
      ),
    );
    return this.views(rows);
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /**
   * A Conversation's cards, oldest first. Cards still PROPOSED whose target
   * changed elsewhere are marked STALE first. The caller has checked that
   * `owner` owns the Conversation.
   */
  async forConversation(owner: User, conversationId: string): Promise<ActionCardView[]> {
    const rows = await this.db.actionCard.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const stale: string[] = [];
    for (const row of rows) {
      if (row.status === 'PROPOSED' && (await this.isStale(row))) stale.push(row.id);
    }
    if (!stale.length) return this.views(rows);
    await this.db.actionCard.updateMany({
      where: { id: { in: stale }, status: 'PROPOSED' },
      data: { status: 'STALE', reviewedAt: new Date() },
    });
    const updated = await this.db.actionCard.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const card of updated) {
      if (stale.includes(card.id)) await this.announce(owner, card);
    }
    return this.views(updated);
  }

  /** Cards as views, each with what it proposes read from its target. */
  private views(rows: ActionCardRow[]): Promise<ActionCardView[]> {
    return Promise.all(rows.map((row) => this.view(row)));
  }

  private async view(row: ActionCardRow): Promise<ActionCardView> {
    return toActionCardView(row, await this.detail(row));
  }

  /** What the card proposes, as its target stands now; null once the target is gone. */
  private async detail(card: ActionCardRow): Promise<ActionCardDetail | null> {
    const person = { select: { id: true, name: true } } as const;
    switch (card.kind) {
      case 'DECISION_REQUEST': {
        const request = await this.db.decisionRequest.findUnique({
          where: { id: card.targetId },
          include: {
            feature: { select: { teamId: true } },
            choices: { orderBy: { position: 'asc' } },
          },
        });
        if (!request) return null;
        return {
          kind: 'DECISION_REQUEST',
          requestKind: request.kind,
          description: request.description,
          deciderRole: request.deciderRole,
          recipients: await this.decisionRequests.candidates(
            {
              featureId: request.featureId,
              teamId: request.feature.teamId,
              raiserId: request.raiserId,
            },
            request.deciderRole,
          ),
          choices: request.choices.map((c) => ({
            label: c.label,
            title: c.title,
            description: c.description,
            impactScope: c.impactScope,
            impactTime: c.impactTime,
            impactRisk: c.impactRisk,
          })),
        };
      }
      case 'SPEC_PROPOSAL': {
        const proposal = await this.db.specProposal.findUnique({
          where: { id: card.targetId },
          include: {
            approver: person,
            baseVersion: { select: { version: true, markdown: true } },
            resultVersion: { select: { version: true } },
          },
        });
        if (!proposal) return null;
        return {
          kind: 'SPEC_PROPOSAL',
          featureId: proposal.featureId,
          approver: proposal.approver,
          baseVersion: proposal.baseVersion?.version ?? null,
          baseMarkdown: proposal.baseVersion?.markdown ?? '',
          proposedMarkdown: proposal.proposedMarkdown,
          version: proposal.resultVersion?.version ?? null,
        };
      }
      case 'BRIEF_PROPOSAL': {
        const proposal = await this.db.briefProposal.findUnique({
          where: { id: card.targetId },
          include: {
            approver: person,
            baseVersion: { select: { version: true, markdown: true } },
            resultVersion: { select: { version: true } },
          },
        });
        if (!proposal) return null;
        return {
          kind: 'BRIEF_PROPOSAL',
          projectId: proposal.projectId,
          approver: proposal.approver,
          baseVersion: proposal.baseVersion?.version ?? null,
          baseMarkdown: proposal.baseVersion?.markdown ?? '',
          proposedMarkdown: proposal.proposedMarkdown,
          version: proposal.resultVersion?.version ?? null,
        };
      }
      case 'FEATURE_SUGGESTION': {
        const suggestion = await this.db.featureSuggestion.findUnique({
          where: { id: card.targetId },
        });
        if (!suggestion) return null;
        return {
          kind: 'FEATURE_SUGGESTION',
          rationale: suggestion.rationale,
          businessValue: suggestion.businessValue,
          effort: suggestion.effort,
          risk: suggestion.risk,
          dismissReason: suggestion.dismissReason,
          featureId: suggestion.featureId,
        };
      }
    }
  }

  // ─── Approving and declining ──────────────────────────────────────────────

  /** The owner approves: the target's own service sends, approves or accepts it. */
  async approve(user: User, id: string, input: ApproveActionCardInput): Promise<ActionCardView> {
    return this.act(user, id, async (card) => {
      const { deciderRole, recipients, choices, teamId } = input ?? {};
      if ((deciderRole || recipients || choices) && card.kind !== 'DECISION_REQUEST') {
        throw new UnprocessableEntityException(
          '`deciderRole`, `recipients` and `choices` only apply to a Decision Request card',
        );
      }
      if (teamId && card.kind !== 'FEATURE_SUGGESTION') {
        throw new UnprocessableEntityException(
          '`teamId` only applies to a Feature Suggestion card',
        );
      }
      switch (card.kind) {
        case 'DECISION_REQUEST': {
          const draft = await this.decisionRequests.get(user, card.targetId);
          await this.decisionRequests.submit(user, card.targetId, {
            deciderRole: deciderRole ?? draft.deciderRole,
            recipients: recipients ?? 'ALL',
            ...(choices ? { choices } : {}),
          });
          break;
        }
        case 'SPEC_PROPOSAL':
          await this.spec.approve(user, card.targetId);
          break;
        case 'BRIEF_PROPOSAL':
          await this.brief.approve(user, card.targetId);
          break;
        case 'FEATURE_SUGGESTION':
          await this.suggestions.accept(user, card.targetId, {
            teamId: teamId ?? (await this.defaultTeam(user, card.targetId)),
          });
          break;
      }
      return 'APPROVED';
    });
  }

  /** The owner declines: the draft is withdrawn, the proposal rejected, the suggestion dismissed. */
  async decline(user: User, id: string, input: DeclineActionCardInput): Promise<ActionCardView> {
    return this.act(user, id, async (card) => {
      if (input?.reason && card.kind !== 'FEATURE_SUGGESTION') {
        throw new UnprocessableEntityException(
          '`reason` only applies to a Feature Suggestion card',
        );
      }
      switch (card.kind) {
        case 'DECISION_REQUEST':
          await this.decisionRequests.withdraw(user, card.targetId);
          break;
        case 'SPEC_PROPOSAL':
          await this.spec.reject(user, card.targetId);
          break;
        case 'BRIEF_PROPOSAL':
          await this.brief.reject(user, card.targetId);
          break;
        case 'FEATURE_SUGGESTION':
          await this.suggestions.dismiss(user, card.targetId, {
            reason: input?.reason ?? DEFAULT_DECLINE_REASON,
          });
          break;
      }
      return 'DECLINED';
    });
  }

  /**
   * Runs `work` on a PROPOSED card the user owns, one action per card at a time,
   * and records its outcome. A card already reviewed, or whose target changed
   * elsewhere (it becomes STALE), is a 409. When the target's service refuses,
   * the card stays PROPOSED, unless the refusal came from a change elsewhere.
   */
  private async act(
    user: User,
    id: string,
    work: (card: ActionCardRow) => Promise<'APPROVED' | 'DECLINED'>,
  ): Promise<ActionCardView> {
    const owned = await this.owned(user, id);
    await projectAccess(this.db, user, owned.conversation.projectId);
    if (this.acting.has(id)) {
      throw new ConflictException('This Action Card is already being approved or declined');
    }
    this.acting.add(id);
    try {
      const card = await this.db.actionCard.findUniqueOrThrow({ where: { id } });
      if (card.status !== 'PROPOSED') {
        throw new ConflictException(`This Action Card is already ${card.status.toLowerCase()}`);
      }
      if (await this.isStale(card)) {
        await this.mark(user, card, 'STALE');
        throw new ConflictException(
          'What this Action Card proposes changed elsewhere, so it can no longer be approved or declined',
        );
      }
      let outcome: 'APPROVED' | 'DECLINED';
      try {
        outcome = await work(card);
      } catch (error) {
        if (error instanceof ConflictException && (await this.isStale(card))) {
          await this.mark(user, card, 'STALE');
        }
        throw error;
      }
      return this.view(await this.mark(user, card, outcome));
    } finally {
      this.acting.delete(id);
    }
  }

  private async mark(
    owner: User,
    card: ActionCardRow,
    status: 'APPROVED' | 'DECLINED' | 'STALE',
  ): Promise<ActionCardRow> {
    await this.db.actionCard.updateMany({
      where: { id: card.id, status: 'PROPOSED' },
      data: { status, reviewedAt: new Date() },
    });
    const updated = await this.db.actionCard.findUniqueOrThrow({ where: { id: card.id } });
    await this.announce(owner, updated);
    return updated;
  }

  private async announce(owner: User, card: ActionCardRow) {
    this.bus.emit(owner.id, {
      event: 'conversation.actionCard.updated',
      data: { conversationId: card.conversationId, card: await this.view(card) },
    });
  }

  /** The card, if the user owns its Conversation; 404 otherwise, whoever asks. */
  private async owned(user: User, id: string) {
    const card = await this.db.actionCard.findFirst({
      where: { id, conversation: { ownerId: user.id } },
      include: { conversation: { select: { projectId: true } } },
    });
    if (!card) throw new NotFoundException('Action Card not found');
    return card;
  }

  /** Whether the target is no longer the draft the card proposed. */
  private async isStale(card: ActionCardRow): Promise<boolean> {
    switch (card.kind) {
      case 'DECISION_REQUEST': {
        const request = await this.db.decisionRequest.findUnique({
          where: { id: card.targetId },
          select: { status: true },
        });
        return request?.status !== 'DRAFT';
      }
      case 'SPEC_PROPOSAL': {
        const proposal = await this.db.specProposal.findUnique({
          where: { id: card.targetId },
          select: { status: true, featureId: true, baseVersionId: true },
        });
        if (proposal?.status !== 'PENDING') return true;
        const latest = await this.db.specVersion.findFirst({
          where: { featureId: proposal.featureId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        return (latest?.id ?? null) !== proposal.baseVersionId;
      }
      case 'BRIEF_PROPOSAL': {
        const proposal = await this.db.briefProposal.findUnique({
          where: { id: card.targetId },
          select: { status: true, projectId: true, baseVersionId: true },
        });
        if (proposal?.status !== 'PENDING') return true;
        const latest = await this.db.briefVersion.findFirst({
          where: { projectId: proposal.projectId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        return (latest?.id ?? null) !== proposal.baseVersionId;
      }
      case 'FEATURE_SUGGESTION': {
        const suggestion = await this.db.featureSuggestion.findUnique({
          where: { id: card.targetId },
          select: { status: true },
        });
        return suggestion?.status !== 'PENDING';
      }
    }
  }

  /**
   * The Team an accepted Feature Suggestion goes to when the person didn't say:
   * the Project's only Team, or the only one of its Teams where they are PO.
   */
  private async defaultTeam(user: User, suggestionId: string): Promise<string> {
    const suggestion = await this.db.featureSuggestion.findUniqueOrThrow({
      where: { id: suggestionId },
      select: { projectId: true },
    });
    const teams = await this.db.team.findMany({
      where: { projectId: suggestion.projectId },
      select: {
        id: true,
        members: { where: { userId: user.id, role: 'PO' }, select: { id: true } },
      },
    });
    const only = teams.length === 1 ? teams : teams.filter((t) => t.members.length > 0);
    if (only.length === 1 && only[0]) return only[0].id;
    throw new UnprocessableEntityException(
      'Say which of the Project’s Teams the Feature goes to (`teamId`)',
    );
  }
}

function refusal(error: string): ToolRun {
  return { content: JSON.stringify({ ok: false, error }), cards: [] };
}

function requireFeature(scope: ToolScope): string {
  if (!scope.featureId) {
    throw new UnprocessableEntityException('This tool only works in a Feature Conversation');
  }
  return scope.featureId;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS - 1)}…`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : 'arguments'}: ${i.message}`)
    .join('; ');
}
