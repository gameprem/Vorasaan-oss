import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ChatCard, ChatEventKind, Prisma, PrismaClient } from '@vorasaan/db';
import type { ChatProvider } from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import type { ChatCardSignal } from '../inbox/chat-card-signals.ts';
import { ChatCardSignals } from '../inbox/chat-card-signals.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ActionTokens } from './action-token.ts';
import type { ChatMessage, MessageRef } from './adapters/adapter.ts';
import { ChatApiError } from './adapters/http.ts';
import {
  type CardContext,
  type CardRequest,
  decisionCard,
  needsInfoCard,
  overdueCard,
  specProposalCard,
} from './cards.ts';
import { ChatAccountsService, toAddress } from './chat-accounts.service.ts';
import { ChatAdapters } from './chat-adapters.ts';
import { ChatAppSettingsService } from './chat-app-settings.service.ts';
import { chatText } from './chat-text.ts';
import { chatDelivery } from './delivery.ts';

const person = { select: { id: true, name: true } } as const;

/** Everything a card or a press needs about a Decision Request, and nothing more. */
export const cardRequestInclude = {
  feature: { select: { title: true } },
  raiser: person,
  decider: person,
  recipients: { select: { userId: true } },
  choices: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      label: true,
      title: true,
      impactScope: true,
      impactTime: true,
      impactRisk: true,
    },
  },
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { kind: true, body: true, author: person },
  },
  decision: {
    select: {
      decidedBy: person,
      choice: { select: { label: true, title: true } },
      specProposal: { select: { id: true } },
    },
  },
} satisfies Prisma.DecisionRequestInclude;

export type LoadedRequest = Prisma.DecisionRequestGetPayload<{
  include: typeof cardRequestInclude;
}>;

export function toCardRequest(r: LoadedRequest): CardRequest {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    featureTitle: r.feature.title,
    raiserName: r.raiser.name,
    dueAt: r.dueAt,
    paused: r.pausedAt !== null,
    choices: r.choices,
  };
}

/** Whether `userId` can still decide it: OPEN, sent to them, and nobody else's to decide. */
export const canDecide = (r: LoadedRequest, userId: string) =>
  r.status === 'OPEN' &&
  r.recipients.some((x) => x.userId === userId) &&
  (r.deciderId === null || r.deciderId === userId);

/** Which of a person's chat preferences a signal falls under. */
function eventOf(signal: ChatCardSignal): ChatEventKind {
  // Escalation step 2 adds a Delegate as a Recipient: to them it is a new request.
  if (signal.kind === 'ESCALATION') return signal.step === 2 ? 'DECISION_REQUEST' : 'ESCALATION';
  return signal.kind;
}

/**
 * Cards in people's chat apps (ADR 0011, ticket 0058). Decision Requests, NEEDS_INFO
 * questions, escalation steps and Spec Proposals reach it as ChatCardSignals once their
 * change has committed. Each person gets one card per linked Chat Account, if their
 * chat preferences want that kind of card. During their Quiet Hours a card waits
 * (PENDING) and goes out once they end, if it still matters then. Sending never blocks
 * or fails the change: it runs in the background, and a provider error is logged
 * (provider and HTTP status only) and marks the card FAILED; the Inbox still has it.
 */
@Injectable()
export class ChatCardsService implements OnModuleInit {
  private readonly logger = new Logger(ChatCardsService.name);
  private readonly running = new Set<Promise<void>>();
  private tokens: ActionTokens | undefined;

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
    private readonly signals: ChatCardSignals,
    private readonly settings: ChatAppSettingsService,
    private readonly accounts: ChatAccountsService,
    private readonly adapters: ChatAdapters,
  ) {}

  onModuleInit() {
    this.signals.listen((signals) => {
      for (const signal of signals) this.background(() => this.deliver(signal));
    });
  }

  /** Lazily, like the credentials' SecretBox: the server boots without VORASAAN_SECRET_KEY. */
  actionTokens(): ActionTokens {
    this.tokens ??= ActionTokens.fromEnv();
    return this.tokens;
  }

  private background(work: () => Promise<void>) {
    const run = work()
      .catch((error) => this.logger.error(failure(error, 'Could not send chat cards')))
      .finally(() => this.running.delete(run));
    this.running.add(run);
  }

  /** Waits for cards being sent (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  /** Creates the cards a signal asks for, and sends those not held by Quiet Hours. */
  async deliver(signal: ChatCardSignal): Promise<void> {
    const organizationId = await this.settings.organizationId();
    if (!organizationId) return;
    const enabled = [...(await this.settings.enabled(organizationId))];
    if (!enabled.length) return;
    const event = eventOf(signal);
    const now = this.clock.now();
    for (const userId of signal.to) {
      try {
        await this.deliverTo(userId, signal, event, organizationId, enabled, now);
      } catch (error) {
        // One person's cards never stop the others'.
        this.logger.warn(failure(error, 'Could not send a chat card'));
      }
    }
  }

  private async deliverTo(
    userId: string,
    signal: ChatCardSignal,
    event: ChatEventKind,
    organizationId: string,
    enabled: ChatProvider[],
    now: Date,
  ) {
    const linked = await this.db.chatAccount.findMany({
      where: { userId, organizationId, provider: { in: enabled } },
      select: { provider: true },
    });
    if (!linked.length) return;
    const prefs = await this.accounts.deliveryPreferences({ id: userId });
    const delivery = chatDelivery(prefs, event, now);
    if (delivery === 'not-chosen') return;
    for (const { provider } of linked) {
      const card = await this.db.chatCard.create({
        data: {
          userId,
          provider,
          event,
          requestId: signal.requestId,
          specProposalId: signal.kind === 'SPEC_PROPOSAL' ? signal.specProposalId : null,
          escalationStep: signal.kind === 'ESCALATION' ? signal.step : null,
          createdAt: now,
        },
      });
      if (delivery === 'send') await this.send(card);
    }
  }

  /**
   * Sends the cards Quiet Hours held back, once they are over. Run every minute by
   * ChatCardsScheduler. A card that no longer matters (decided, withdrawn, answered,
   * unlinked, or its kind switched off meanwhile) is SKIPPED instead.
   */
  async flush(): Promise<{ sent: number; skipped: number; waiting: number }> {
    const now = this.clock.now();
    const pending = await this.db.chatCard.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const result = { sent: 0, skipped: 0, waiting: 0 };
    for (const card of pending) {
      try {
        const prefs = await this.accounts.deliveryPreferences({ id: card.userId });
        const delivery = chatDelivery(prefs, card.event, now);
        if (delivery === 'quiet-hours') {
          result.waiting++;
          continue;
        }
        if (delivery === 'not-chosen') {
          await this.mark(card.id, 'SKIPPED');
          result.skipped++;
          continue;
        }
        const status = await this.send(card);
        if (status === 'SENT') result.sent++;
        else if (status === 'SKIPPED') result.skipped++;
      } catch (error) {
        // E.g. the person left the Organization: their card is dropped, the others go on.
        this.logger.warn(failure(error, 'Could not send a held chat card'));
        await this.mark(card.id, 'SKIPPED');
        result.skipped++;
      }
    }
    return result;
  }

  private async mark(id: string, status: 'SKIPPED' | 'FAILED') {
    await this.db.chatCard.updateMany({ where: { id, status: 'PENDING' }, data: { status } });
  }

  /** Builds a card from the request as it is now, and sends it once. */
  private async send(card: ChatCard): Promise<'SENT' | 'SKIPPED' | 'FAILED' | null> {
    const connection = await this.settings.connection(card.provider);
    const account = await this.db.chatAccount.findUnique({
      where: { userId_provider: { userId: card.userId, provider: card.provider } },
    });
    const prefs = await this.accounts.deliveryPreferences({ id: card.userId });
    const ctx: CardContext = {
      lang: prefs.language,
      timeZone: prefs.timeZone,
      now: this.clock.now(),
    };
    const message =
      connection && account && account.organizationId === connection.organizationId
        ? await this.build(card, ctx)
        : null;
    if (!connection || !account || !message) {
      await this.mark(card.id, 'SKIPPED');
      return 'SKIPPED';
    }
    // Claimed before sending, so two flushes never send the same card twice.
    const claimed = await this.db.chatCard.updateMany({
      where: { id: card.id, status: 'PENDING' },
      data: { status: 'SENT', sentAt: ctx.now },
    });
    if (claimed.count !== 1) return null;
    try {
      const ref = await this.adapters
        .get(card.provider)
        .send(
          connection.credentials,
          { providerUserId: account.providerUserId, address: toAddress(account.address) },
          message,
        );
      if (ref) {
        await this.db.chatCard.update({ where: { id: card.id }, data: { messageRef: ref } });
      }
      return 'SENT';
    } catch (error) {
      this.logger.warn(failure(error, `Could not send a card on ${card.provider}`));
      await this.db.chatCard.update({ where: { id: card.id }, data: { status: 'FAILED' } });
      return 'FAILED';
    }
  }

  /** The card's message as of now, or null when it no longer matters to its person. */
  async build(card: ChatCard, ctx: CardContext): Promise<ChatMessage | null> {
    const t = chatText(ctx.lang);
    if (card.event === 'SPEC_PROPOSAL') {
      if (!card.specProposalId) return null;
      const proposal = await this.db.specProposal.findUnique({
        where: { id: card.specProposalId },
        select: {
          id: true,
          featureId: true,
          status: true,
          approverId: true,
          feature: { select: { title: true } },
          decision: { select: { request: { select: { title: true } } } },
        },
      });
      if (proposal?.status !== 'PENDING' || proposal.approverId !== card.userId) {
        return null;
      }
      return specProposalCard(
        {
          id: proposal.id,
          featureId: proposal.featureId,
          featureTitle: proposal.feature.title,
          requestTitle: proposal.decision?.request.title ?? null,
        },
        ctx,
      );
    }

    if (!card.requestId) return null;
    const request = await this.loadRequest(card.requestId);
    if (!request) return null;
    const view = toCardRequest(request);
    const sign = (action: Parameters<ActionTokens['sign']>[1]) =>
      this.actionTokens().sign(card.id, action);
    const last = request.messages[0];

    if (card.event === 'NEEDS_INFO') {
      if (request.status !== 'NEEDS_INFO' || request.raiserId !== card.userId) return null;
      return needsInfoCard(
        view,
        ctx,
        last?.kind === 'QUESTION' ? { deciderName: last.author.name, body: last.body } : null,
      );
    }
    if (card.escalationStep === 3) {
      if (request.status !== 'OPEN') return null;
      const waitingOn = request.decider
        ? [request.decider.name]
        : await this.names(request.recipients.map((r) => r.userId));
      return overdueCard(view, ctx, waitingOn);
    }
    // A request to decide: as sent, with the Raiser's answer, as a reminder, or to a Delegate.
    if (!canDecide(request, card.userId)) return null;
    const heading =
      card.escalationStep === 1
        ? t.reminderHeading
        : card.escalationStep === 2
          ? t.delegateHeading
          : undefined;
    const answer = last?.kind === 'ANSWER' ? last.body : undefined;
    return decisionCard(view, ctx, sign, { heading, answer });
  }

  loadRequest(id: string): Promise<LoadedRequest | null> {
    return this.db.decisionRequest.findUnique({ where: { id }, include: cardRequestInclude });
  }

  private async names(userIds: string[]): Promise<string[]> {
    const people = await this.db.user.findMany({
      where: { id: { in: userIds } },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    return people.map((p) => p.name);
  }

  /** Replaces a sent card after a press, where the provider can (Slack, Teams). */
  async update(card: ChatCard, message: ChatMessage): Promise<void> {
    const ref = card.messageRef as MessageRef | null;
    if (!ref || typeof ref !== 'object') return;
    try {
      const connection = await this.settings.connection(card.provider as ChatProvider);
      if (!connection) return;
      await this.adapters.get(card.provider).update(connection.credentials, ref, message);
    } catch (error) {
      this.logger.warn(failure(error, `Could not update a card on ${card.provider}`));
    }
  }
}

/** A log line that names the provider and status at most: never a token or a body. */
export function failure(error: unknown, fallback: string): string {
  return error instanceof ChatApiError ? error.message : fallback;
}
