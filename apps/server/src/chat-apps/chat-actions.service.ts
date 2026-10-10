import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ChatCard, PrismaClient, User } from '@vorasaan/db';
import {
  type ChatLanguage,
  type ChatProvider,
  DecideInput,
  PostRequestMessageInput,
  RequestChangesInput,
} from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { DecisionRequestsService } from '../decision-requests/decision-requests.service.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { type ProposalRef, RedraftsService } from '../redrafts/redrafts.service.ts';
import type { ActionToken, CardAction } from './action-token.ts';
import type { CardInput, ChatMessage, ChatUser } from './adapters/adapter.ts';
import { type CardContext, outcomeCard, proposalUrl, requestUrl } from './cards.ts';
import { ChatAccountsService } from './chat-accounts.service.ts';
import {
  ChatCardsService,
  failure,
  type LoadedRequest,
  toCardRequest,
} from './chat-cards.service.ts';
import { chatText, PROMPT_MINUTES } from './chat-text.ts';

/** A press (or the text typed behind one), as the provider verified it. */
export type Press = {
  organizationId: string;
  provider: ChatProvider;
  user: ChatUser;
  /** The button's token, verified here. */
  token: string | ActionToken;
  /** Typed into the input behind the button, when the provider sends it with the press. */
  text: string | null;
  reply: (message: ChatMessage) => Promise<void>;
  openInput?: (input: CardInput) => Promise<void>;
};

type Prompt = { cardId: string; action: CardAction; expiresAt: number };

/**
 * Button presses on cards (ADR 0011, ticket 0058). A press counts as a person only when
 * it comes from their linked Chat Account (the provider's verified user id), on a card
 * that was sent to that same person; the button's own payload names no one. It then
 * calls the same DecisionRequestsService methods as the web app, so every rule (who may
 * decide, the state machine, Claims) is the web's. A request that changed since the
 * card went out gets "already decided by …" (or Claimed, withdrawn, waiting) instead.
 */
@Injectable()
export class ChatActionsService {
  private readonly logger = new Logger(ChatActionsService.name);
  /**
   * LINE has no modal: after "Ask for more info" or "Write your own answer", the person's
   * next text message within PROMPT_MINUTES is taken as the text. Kept in memory per
   * chat account, like SeenEvents (one server process per Organization).
   */
  private readonly prompts = new Map<string, Prompt>();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
    private readonly accounts: ChatAccountsService,
    private readonly cards: ChatCardsService,
    private readonly requests: DecisionRequestsService,
    private readonly redrafts: RedraftsService,
  ) {}

  /** The reply prompt waiting for this chat account's next message, taken once. */
  takePrompt(provider: ChatProvider, providerUserId: string): ActionToken | null {
    const key = `${provider}:${providerUserId}`;
    const prompt = this.prompts.get(key);
    this.prompts.delete(key);
    if (!prompt || prompt.expiresAt <= this.clock.now().getTime()) return null;
    return { cardId: prompt.cardId, action: prompt.action };
  }

  async press(press: Press): Promise<void> {
    const { provider } = press;
    const account = await this.accounts.accountFor(press.organizationId, provider, press.user.id);
    const lang: ChatLanguage = account
      ? await this.accounts.languageOf(account.userId)
      : await this.accounts.organizationLanguage(press.organizationId);
    const t = chatText(lang);
    const say = (text: string) => this.reply(press, { text });

    // Who: only the linked Chat Account, as the provider identified it.
    if (!account) return say(t.notLinked(provider));
    const token =
      typeof press.token === 'string' ? this.cards.actionTokens().verify(press.token) : press.token;
    if (!token) return say(t.invalidButton);
    const card = await this.db.chatCard.findUnique({ where: { id: token.cardId } });
    if (!card?.requestId) return say(t.invalidButton);
    // A card answers only to the person it was sent to, in the chat app it was sent to.
    if (card.userId !== account.userId || card.provider !== provider) return say(t.notYours);
    const user = await this.db.user.findUnique({ where: { id: account.userId } });
    if (!user) return say(t.notLinked(provider));

    const prefs = await this.accounts.deliveryPreferences(user);
    const ctx: CardContext = { lang, timeZone: prefs.timeZone, now: this.clock.now() };
    // A Spec Proposal card's only button: Request changes on the proposal (0065).
    if (card.event === 'SPEC_PROPOSAL') {
      if (token.action.kind !== 'redraft' || !card.specProposalId) return say(t.invalidButton);
      return this.redraft(press, card, user, ctx, {
        kind: 'SPEC_PROPOSAL',
        id: card.specProposalId,
      });
    }
    const request = await this.cards.loadRequest(card.requestId);
    if (!request) return say(t.invalidButton);

    // Changed since the card went out: say so, and change nothing.
    const changed = this.changed(request, user.id, ctx);
    if (changed) return this.finish(press, card, request, ctx, changed);

    const { action } = token;
    if (action.kind === 'redraft') {
      return this.redraft(press, card, user, ctx, { kind: 'CHOICES', id: request.id });
    }
    if (action.kind !== 'choice' && press.text === null) {
      return this.askForText(press, card, action, request, ctx);
    }

    try {
      if (action.kind === 'ask') {
        const input = PostRequestMessageInput.safeParse({ kind: 'QUESTION', body: press.text });
        if (!input.success) return say(t.emptyText);
        await this.requests.postMessage(user, request.id, input.data);
        return this.finish(press, card, request, ctx, t.asked(request.raiser.name));
      }
      const input = DecideInput.safeParse(
        action.kind === 'choice' ? { choiceId: action.choiceId } : { customAnswer: press.text },
      );
      if (!input.success) return say(t.emptyText);
      const { proposal } = await this.requests.decide(user, request.id, input.data, provider);
      const choice =
        action.kind === 'choice'
          ? (request.choices.find((c) => c.id === action.choiceId) ?? null)
          : null;
      const decided = t.decided(choice);
      await say(`${decided} ${t.proposalReady(proposalUrl(proposal.featureId, proposal.id))}`);
      await this.cards.update(card, outcomeCard(toCardRequest(request), ctx, decided));
    } catch (error) {
      await this.refused(press, card, user, ctx, error);
    }
  }

  /**
   * Request changes pressed (ADR 0013, ticket 0065), on a decision card (the Choices) or a
   * Spec Proposal card: first the text input, as Ask for more info does; then, with the
   * feedback, the same RedraftsService as the web, as the linked person, so who may
   * redraft and when is the web's. The reply links to the Redraft in Vorasaan.
   */
  private async redraft(
    press: Press,
    card: ChatCard,
    user: User,
    ctx: CardContext,
    ref: ProposalRef,
  ) {
    const t = chatText(ctx.lang);
    if (press.text === null) {
      return this.openText(press, card, { kind: 'redraft' }, ctx, {
        label: t.redraft,
        title: t.redraftTitle,
        inputLabel: ref.kind === 'CHOICES' ? t.redraftChoicesLabel : t.redraftProposalLabel,
        placeholder: t.redraftPlaceholder,
        prompt: t.promptRedraft,
      });
    }
    const input = RequestChangesInput.safeParse({ feedback: press.text });
    if (!input.success) return this.reply(press, { text: t.emptyText });
    let started: Awaited<ReturnType<RedraftsService['start']>>;
    try {
      started = await this.redrafts.start(user, ref, input.data);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        return this.reply(press, { text: t.redraftNotAllowed });
      }
      if (error instanceof ConflictException || error instanceof UnprocessableEntityException) {
        return this.reply(press, { text: t.redraftRefused });
      }
      if (error instanceof NotFoundException) return this.reply(press, { text: t.invalidButton });
      this.logger.error(`A ${press.provider} Request changes failed`, (error as Error)?.name);
      return this.reply(press, { text: t.failed });
    }
    await this.reply(press, { text: t.redraftStarted(started.number) });
    try {
      await started.done;
    } catch {
      return this.reply(press, { text: t.redraftFailed });
    }
    let url = requestUrl(ref.id);
    if (ref.kind === 'SPEC_PROPOSAL') {
      const proposal = await this.db.specProposal.findUnique({
        where: { id: ref.id },
        select: { featureId: true },
      });
      if (proposal) url = proposalUrl(proposal.featureId, ref.id, started.number);
    }
    await this.reply(press, { text: t.redraftReady(started.number, url) });
    // LINE can't edit the card it sent: the new Choices come as a new card instead.
    if (ref.kind === 'CHOICES' && !card.messageRef) {
      const message = await this.cards.build(card, { ...ctx, now: this.clock.now() });
      if (message) await this.reply(press, message);
    }
  }

  /** "Ask for more info" or "Write your own answer" pressed: open the text input. */
  private async askForText(
    press: Press,
    card: ChatCard,
    action: CardAction,
    request: LoadedRequest,
    ctx: CardContext,
  ) {
    const t = chatText(ctx.lang);
    const ask = action.kind === 'ask';
    return this.openText(press, card, action, ctx, {
      label: ask ? t.ask : t.own,
      title: ask ? t.askTitle : t.ownTitle,
      inputLabel: ask ? t.askLabel(request.raiser.name) : t.ownLabel,
      placeholder: ask ? t.askPlaceholder : t.ownPlaceholder,
      prompt: ask ? t.promptAsk(request.raiser.name) : t.promptOwn,
    });
  }

  /** The text input behind a button: Slack's modal, or LINE's next message. */
  private async openText(
    press: Press,
    card: ChatCard,
    action: CardAction,
    ctx: CardContext,
    text: { label: string; title: string; inputLabel: string; placeholder: string; prompt: string },
  ) {
    const t = chatText(ctx.lang);
    const tokens = this.cards.actionTokens();
    if (press.openInput) {
      // Slack: a modal, whose submission comes back with the same signed token.
      try {
        await press.openInput({
          label: text.label,
          token: tokens.sign(card.id, action),
          title: text.title,
          inputLabel: text.inputLabel,
          placeholder: text.placeholder,
          submit: t.send,
          cancel: t.cancel,
        });
      } catch (error) {
        this.logger.warn(failure(error, `Could not open a modal on ${press.provider}`));
      }
      return;
    }
    // LINE: the next message is the text.
    this.prompts.set(`${press.provider}:${press.user.id}`, {
      cardId: card.id,
      action,
      expiresAt: ctx.now.getTime() + PROMPT_MINUTES * 60_000,
    });
    if (this.prompts.size > 10_000) {
      for (const [key, p] of this.prompts)
        if (p.expiresAt <= ctx.now.getTime()) this.prompts.delete(key);
    }
    await this.reply(press, { text: text.prompt });
  }

  /** What changed since the card went out, as a reply; null when the person can act. */
  private changed(request: LoadedRequest, userId: string, ctx: CardContext): string | null {
    const t = chatText(ctx.lang);
    switch (request.status) {
      case 'DECIDED':
      case 'SPEC_UPDATED': {
        const decision = request.decision;
        if (!decision) return t.alreadyDecided('?', null);
        return decision.decidedBy.id === userId
          ? t.youDecided(decision.choice)
          : t.alreadyDecided(decision.decidedBy.name, decision.choice);
      }
      case 'WITHDRAWN':
        return t.withdrawn(request.raiser.name);
      case 'NEEDS_INFO':
        return t.waitingForInfo(request.raiser.name);
      case 'OPEN':
        if (request.decider && request.decider.id !== userId) {
          return t.claimedBy(request.decider.name);
        }
        return null;
      default:
        return t.notAllowed;
    }
  }

  /** The service refused: say why in the person's words, having changed nothing. */
  private async refused(
    press: Press,
    card: ChatCard,
    user: User,
    ctx: CardContext,
    error: unknown,
  ) {
    const t = chatText(ctx.lang);
    if (error instanceof ConflictException && card.requestId) {
      // Someone acted at the same moment: say what happened.
      const request = await this.cards.loadRequest(card.requestId);
      const changed = request && this.changed(request, user.id, ctx);
      if (request && changed) return this.finish(press, card, request, ctx, changed);
      return this.reply(press, { text: t.failed });
    }
    if (error instanceof ForbiddenException) return this.reply(press, { text: t.notAllowed });
    if (error instanceof BadGatewayException) return this.reply(press, { text: t.draftFailed });
    if (error instanceof UnprocessableEntityException || error instanceof NotFoundException) {
      return this.reply(press, { text: t.invalidButton });
    }
    this.logger.error(`A ${press.provider} press failed`, error instanceof Error ? error.name : '');
    return this.reply(press, { text: t.failed });
  }

  /** Replies with the outcome and turns the card into it, where the provider can. */
  private async finish(
    press: Press,
    card: ChatCard,
    request: LoadedRequest,
    ctx: CardContext,
    outcome: string,
  ) {
    await this.reply(press, { text: outcome });
    await this.cards.update(card, outcomeCard(toCardRequest(request), ctx, outcome));
  }

  private async reply(press: Press, message: ChatMessage) {
    try {
      await press.reply(message);
    } catch (error) {
      this.logger.warn(failure(error, `Could not reply on ${press.provider}`));
    }
  }
}
