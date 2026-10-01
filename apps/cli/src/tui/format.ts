import type {
  DecisionRequestStatus,
  DecisionRequestView,
  InboxItem,
  NotificationView,
} from '@vorasaan/shared';
import { ApiError } from '../api.ts';
import { ROLE_LABEL } from '../commands/raise-flow.ts';

/** One readable line for a failed request; the TUI shows it instead of crashing. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your sign-in was rejected. Run `vorasaan login` again.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const kindLabel = (kind: 'BLOCKER' | 'QUESTION') => (kind === 'BLOCKER' ? 'Blocker' : 'Question');

export function inboxItemLine(item: InboxItem): string {
  switch (item.kind) {
    case 'DECIDE':
      return `Decide ${kindLabel(item.decisionRequest.kind)}: ${item.decisionRequest.title} · ${item.feature.title}${item.decisionRequest.onBehalfOf ? ` (for ${item.decisionRequest.onBehalfOf.name})` : ''}`;
    case 'CLAIM':
      return `Claim ${kindLabel(item.decisionRequest.kind)}: ${item.decisionRequest.title} · ${item.feature.title} (${ROLE_LABEL[item.decisionRequest.deciderRole]})`;
    case 'ANSWER':
      return `Answer: ${item.decisionRequest.title} · ${item.feature.title}`;
    case 'APPROVE_PROPOSAL':
      return `Approve Spec Proposal · ${item.feature.title}`;
    case 'ANSWER_GRILLING':
      return `Answer Grilling (${item.grilling.round.toLowerCase()}, ${item.grilling.unanswered} open) · ${item.project.name}`;
    case 'APPROVE_BRIEF_PROPOSAL':
      return `Approve Brief Proposal · ${item.project.name}`;
  }
}

/** The Decision Request an Inbox Item is about, if any. */
export function inboxItemRequestId(item: InboxItem): string | undefined {
  if ('decisionRequest' in item) return item.decisionRequest.id;
  if (item.kind === 'APPROVE_PROPOSAL') return item.specProposal.decisionRequest?.id;
  return undefined;
}

/** What to show for an Inbox Item that has no Decision Request to open. */
export function inboxItemDetail(item: InboxItem): string[] {
  switch (item.kind) {
    case 'APPROVE_PROPOSAL':
      return [
        `A Spec Proposal (${item.specProposal.source.toLowerCase()}) on "${item.feature.title}" waits for your approval.`,
        'Review and approve it in the web app.',
      ];
    case 'ANSWER_GRILLING':
      return [
        `Grilling of "${item.project.name}": ${item.grilling.unanswered} question(s) of the ${item.grilling.round.toLowerCase()} round are asked to the ${ROLE_LABEL[item.grilling.role]}s.`,
        'Answer them in the web app.',
      ];
    case 'APPROVE_BRIEF_PROPOSAL':
      return [
        `A Brief Proposal (${item.briefProposal.source.toLowerCase()}) on "${item.project.name}" waits for your approval.`,
        'Review and approve it in the web app.',
      ];
    default:
      return [inboxItemLine(item)];
  }
}

export function notificationLine(n: NotificationView): string {
  const unread = n.readAt ? '  ' : '• ';
  const feature = n.feature ? ` · ${n.feature.title}` : '';
  switch (n.type) {
    case 'REQUEST_DECIDED':
      return `${unread}Decided: ${n.decisionRequest?.title ?? 'a Decision Request'}${feature}`;
    case 'REQUEST_CLAIMED':
      return `${unread}Claimed: ${n.decisionRequest?.title ?? 'a Decision Request'}${feature}`;
    case 'REQUEST_WITHDRAWN':
      return `${unread}Withdrawn: ${n.decisionRequest?.title ?? 'a Decision Request'}${feature}`;
    case 'SPEC_VERSION_CREATED':
      return `${unread}New Spec Version v${n.specVersion?.version ?? '?'} by ${n.specVersion?.approvedBy.name ?? 'someone'}${feature}`;
    case 'DELEGATION_STARTED':
      return `${unread}You are now the Delegate of ${n.delegation?.delegator.name ?? 'someone'} (${n.delegation ? ROLE_LABEL[n.delegation.role] : ''})`;
  }
}

export const STATUS_LABEL: Record<DecisionRequestStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  NEEDS_INFO: 'Needs info',
  DECIDED: 'Decided',
  SPEC_UPDATED: 'Spec updated',
  WITHDRAWN: 'Withdrawn',
};

export function requestLine(r: DecisionRequestView): string {
  return `[${STATUS_LABEL[r.status]}] ${kindLabel(r.kind)}: ${r.title} · ${r.featureTitle}`;
}

/** The lines of a Decision Request's detail view. */
export function requestDetail(r: DecisionRequestView): string[] {
  const who = r.decider
    ? `Decider: ${r.decider.name}`
    : r.recipients.length
      ? `Sent to: ${r.recipients.map((p) => p.name).join(', ')} (no Decider yet)`
      : 'Not sent yet';
  const lines = [
    `${kindLabel(r.kind)} · ${STATUS_LABEL[r.status]} · ${r.featureTitle}`,
    `Raiser: ${r.raiser.name} · ${ROLE_LABEL[r.deciderRole]} decides · ${who}`,
    '',
    ...r.description.split('\n'),
  ];
  if (r.choices.length) {
    lines.push('', 'Choices');
    for (const c of r.choices) {
      lines.push(
        `  ${c.label}. ${c.title}`,
        `     ${c.description}`,
        `     scope: ${c.impactScope} · time: ${c.impactTime} · risk: ${c.impactRisk}`,
      );
    }
  }
  if (r.messages.length) {
    lines.push('', 'Thread');
    for (const m of r.messages)
      lines.push(`  ${m.author.name} (${m.kind.toLowerCase()}): ${m.body}`);
  }
  if (r.decision) {
    const picked = r.choices.find((c) => c.id === r.decision?.choiceId);
    lines.push(
      '',
      `Decision by ${r.decision.decidedBy.name}${r.decision.onBehalfOf ? ` for ${r.decision.onBehalfOf.name}` : ''}: ${picked ? `${picked.label}. ${picked.title}` : (r.decision.customAnswer ?? '')}`,
    );
    if (r.decision.rationale) lines.push(`  ${r.decision.rationale}`);
  }
  if (r.status === 'OPEN' || r.status === 'NEEDS_INFO') {
    lines.push('', 'Decide, Claim or answer it in the web app.');
  }
  return lines;
}
