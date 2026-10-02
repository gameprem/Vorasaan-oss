import type { ChatLanguage, DecisionRequestKind } from '@vorasaan/shared';
import type { CardAction } from './action-token.ts';
import type { Card, CardInput, ChatMessage } from './adapters/adapter.ts';
import { chatDate, chatText } from './chat-text.ts';

// The cards of ticket 0058, before a provider renders them (adapters/*.ts). By ADR 0011
// they carry only the request's title, its Choices with their impact, short status lines
// and a link: never its description, a Snapshot or any other Attachment content.

/** Where people open Vorasaan; card links point there. */
export function webUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.VORASAAN_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export const requestUrl = (requestId: string) => `${webUrl()}/requests/${requestId}`;
export const proposalUrl = (featureId: string, proposalId: string) =>
  `${webUrl()}/features/${featureId}/proposals/${proposalId}`;

/** What every card is read with: the person's language and time zone, and now. */
export type CardContext = { lang: ChatLanguage; timeZone: string; now: Date };

/** A Decision Request as a card needs it. */
export type CardRequest = {
  id: string;
  kind: DecisionRequestKind;
  title: string;
  featureTitle: string;
  raiserName: string;
  dueAt: Date | null;
  paused: boolean;
  choices: {
    id: string;
    label: string;
    title: string;
    impactScope: string;
    impactTime: string;
    impactRisk: string;
  }[];
};

/** Signs a button for this card. */
export type Sign = (action: CardAction) => string;

/** Lines from free text people wrote (a question, an answer) are kept short on a card. */
const MAX_QUOTE = 500;
const quote = (text: string) =>
  text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 1).trimEnd()}…` : text;
const MAX_IMPACT = 300;
const short = (text: string) =>
  text.length > MAX_IMPACT ? `${text.slice(0, MAX_IMPACT - 1).trimEnd()}…` : text;

function eyebrow(request: CardRequest, ctx: CardContext): string {
  const t = chatText(ctx.lang);
  return `${request.kind === 'BLOCKER' ? t.blocker : t.question} · ${request.featureTitle}`;
}

function dueLine(request: CardRequest, ctx: CardContext): string | null {
  const t = chatText(ctx.lang);
  if (request.paused) return t.paused;
  if (!request.dueAt) return null;
  return t.due(
    chatDate(request.dueAt, ctx.lang, ctx.timeZone),
    request.dueAt.getTime() - ctx.now.getTime(),
  );
}

const message = (card: Card): ChatMessage => ({ text: `${card.eyebrow}: ${card.title}`, card });

/**
 * A Decision Request to decide: a button per Choice, Ask for more info, Write your own
 * answer, and Open in Vorasaan. `heading` marks a reminder or a Delegate's escalation;
 * `answer` is the Raiser's answer when the request comes back from NEEDS_INFO.
 */
export function decisionCard(
  request: CardRequest,
  ctx: CardContext,
  sign: Sign,
  options: { heading?: string; answer?: string } = {},
): ChatMessage {
  const t = chatText(ctx.lang);
  const input = (
    action: CardAction,
    label: string,
    title: string,
    inputLabel: string,
    placeholder: string,
  ): CardInput => ({
    label,
    token: sign(action),
    title,
    inputLabel,
    placeholder,
    submit: t.send,
    cancel: t.cancel,
  });
  const lines = [
    options.heading,
    t.from(request.raiserName),
    dueLine(request, ctx),
    options.answer ? t.answered(request.raiserName, quote(options.answer)) : null,
  ].filter((line): line is string => Boolean(line));
  return message({
    accent: request.kind === 'BLOCKER' ? 'blocker' : 'default',
    eyebrow: eyebrow(request, ctx),
    title: request.title,
    lines,
    choices: request.choices.map((c) => ({
      label: c.label,
      title: c.title,
      impact: [
        `${t.scope}: ${short(c.impactScope)}`,
        `${t.time}: ${short(c.impactTime)}`,
        `${t.risk}: ${short(c.impactRisk)}`,
      ],
      button: { label: t.choose(c.label), token: sign({ kind: 'choice', choiceId: c.id }) },
    })),
    ask: input(
      { kind: 'ask' },
      t.ask,
      t.askTitle,
      t.askLabel(request.raiserName),
      t.askPlaceholder,
    ),
    own: input({ kind: 'own' }, t.own, t.ownTitle, t.ownLabel, t.ownPlaceholder),
    ownShortLabel: t.ownShort,
    link: { label: t.open, url: requestUrl(request.id) },
  });
}

/** A card without buttons: a notice with a link (NEEDS_INFO, overdue, a Spec Proposal). */
export function noticeCard(
  input: {
    accent: Card['accent'];
    eyebrow: string;
    title: string;
    lines: (string | null)[];
    link: Card['link'];
  },
  ctx: CardContext,
): ChatMessage {
  return message({
    accent: input.accent,
    eyebrow: input.eyebrow,
    title: input.title,
    lines: input.lines.filter((line): line is string => Boolean(line)),
    choices: [],
    ask: null,
    own: null,
    ownShortLabel: chatText(ctx.lang).ownShort,
    link: input.link,
  });
}

/** The Decider's question, to the Raiser: answering needs Vorasaan. */
export function needsInfoCard(
  request: CardRequest,
  ctx: CardContext,
  question: { deciderName: string; body: string } | null,
): ChatMessage {
  const t = chatText(ctx.lang);
  return noticeCard(
    {
      accent: request.kind === 'BLOCKER' ? 'blocker' : 'default',
      eyebrow: `${t.needsInfoHeading} · ${request.featureTitle}`,
      title: request.title,
      lines: [question ? t.asks(question.deciderName, quote(question.body)) : null],
      link: { label: t.answerInVorasaan, url: requestUrl(request.id) },
    },
    ctx,
  );
}

/** Escalation step 3, to the Raiser and the Team's Tech Leads. */
export function overdueCard(
  request: CardRequest,
  ctx: CardContext,
  waitingOn: string[],
): ChatMessage {
  const t = chatText(ctx.lang);
  return noticeCard(
    {
      accent: request.kind === 'BLOCKER' ? 'blocker' : 'default',
      eyebrow: `${t.overdueHeading} · ${eyebrow(request, ctx)}`,
      title: request.title,
      lines: [waitingOn.length ? t.overdueLine(waitingOn.join(', ')) : null, dueLine(request, ctx)],
      link: { label: t.open, url: requestUrl(request.id) },
    },
    ctx,
  );
}

/** A Spec Proposal only links to Vorasaan: a diff needs a real screen (ADR 0011). */
export function specProposalCard(
  proposal: { id: string; featureId: string; featureTitle: string; requestTitle: string | null },
  ctx: CardContext,
): ChatMessage {
  const t = chatText(ctx.lang);
  return noticeCard(
    {
      accent: 'default',
      eyebrow: `${t.proposalHeading} · ${proposal.featureTitle}`,
      title: proposal.requestTitle ?? proposal.featureTitle,
      lines: [t.proposalLine],
      link: { label: t.review, url: proposalUrl(proposal.featureId, proposal.id) },
    },
    ctx,
  );
}

/** What a card becomes after a press: what happened, and the link; no buttons left. */
export function outcomeCard(request: CardRequest, ctx: CardContext, outcome: string): ChatMessage {
  const t = chatText(ctx.lang);
  return noticeCard(
    {
      accent: request.kind === 'BLOCKER' ? 'blocker' : 'default',
      eyebrow: eyebrow(request, ctx),
      title: request.title,
      lines: [outcome],
      link: { label: t.open, url: requestUrl(request.id) },
    },
    ctx,
  );
}
