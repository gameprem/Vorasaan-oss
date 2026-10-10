import {
  type DecisionRequestStatus,
  type DecisionRequestView,
  diffLines,
  type InboxItem,
  type NotificationView,
  type PlatformCoverage,
  type ResponseWindowState,
  responseWindowLabels,
} from '@vorasaan/shared';
import { ApiError } from '../api.ts';
import { ROLE_LABEL } from '../commands/raise-flow.ts';
import type { Line } from './components.tsx';

/** One readable line for a failed request; the TUI shows it instead of crashing. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your sign-in was rejected. Run `vorasaan login` again.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const kindLabel = (kind: 'BLOCKER' | 'QUESTION') => (kind === 'BLOCKER' ? 'Blocker' : 'Question');

/** " · due in 2h", " · overdue 1h · escalated", or nothing (ticket 0055). */
export function windowSuffix(state: ResponseWindowState, now: Date = new Date()): string {
  return responseWindowLabels(state, now)
    .map((label) => ` · ${label}`)
    .join('');
}

export function inboxItemLine(item: InboxItem, now: Date = new Date()): string {
  switch (item.kind) {
    case 'DECIDE':
      return `Decide ${kindLabel(item.decisionRequest.kind)}: ${item.decisionRequest.title} · ${item.feature.title}${item.decisionRequest.onBehalfOf ? ` (for ${item.decisionRequest.onBehalfOf.name})` : ''}${windowSuffix(item.decisionRequest.responseWindow, now)}`;
    case 'CLAIM':
      return `Claim ${kindLabel(item.decisionRequest.kind)}: ${item.decisionRequest.title} · ${item.feature.title} (${ROLE_LABEL[item.decisionRequest.deciderRole]})${windowSuffix(item.decisionRequest.responseWindow, now)}`;
    case 'ANSWER':
      return `Answer: ${item.decisionRequest.title} · ${item.feature.title}`;
    case 'APPROVE_PROPOSAL':
      return `Approve Spec Proposal · ${item.feature.title}`;
    case 'ANSWER_GRILLING':
      return `Answer Grilling (${item.grilling.round.toLowerCase()}, ${item.grilling.unanswered} open) · ${item.project.name}`;
    case 'APPROVE_BRIEF_PROPOSAL':
      return `Approve Brief Proposal · ${item.project.name}`;
    case 'APPROVE_DESIGN_DOC':
      return `Approve ${item.designDoc.name} Design Doc${item.designDoc.reason === 'SPEC_CHANGED' ? ' update' : ''} · ${item.feature.title}`;
  }
}

/** The Decision Request an Inbox Item is about, if any. */
export function inboxItemRequestId(item: InboxItem): string | undefined {
  if ('decisionRequest' in item) return item.decisionRequest.id;
  if (item.kind === 'APPROVE_PROPOSAL') return item.specProposal.decisionRequest?.id;
  return undefined;
}

/**
 * Identifies an Inbox Item across reloads, to notice new ones. A request keeps its key
 * when the item changes kind (Claim turns CLAIM into DECIDE), so acting never notifies.
 */
export function inboxItemKey(item: InboxItem): string {
  if ('decisionRequest' in item) return `request:${item.decisionRequest.id}`;
  switch (item.kind) {
    case 'APPROVE_PROPOSAL':
      return `spec-proposal:${item.specProposal.id}`;
    case 'ANSWER_GRILLING':
      return `grilling:${item.grilling.id}:${item.grilling.round}:${item.grilling.role}`;
    case 'APPROVE_BRIEF_PROPOSAL':
      return `brief-proposal:${item.briefProposal.id}`;
    case 'APPROVE_DESIGN_DOC':
      return `design-doc:${item.designDoc.proposalId}`;
  }
}

/** What to show for an Inbox Item that has no screen of its own (a Grilling). */
export function inboxItemDetail(item: InboxItem): string[] {
  switch (item.kind) {
    case 'ANSWER_GRILLING':
      return [
        `Grilling of "${item.project.name}": ${item.grilling.unanswered} question(s) of the ${item.grilling.round.toLowerCase()} round are asked to the ${ROLE_LABEL[item.grilling.role]}s.`,
        'Answer them in the web app.',
      ];
    case 'APPROVE_DESIGN_DOC':
      return [
        `The AI drafted the ${item.designDoc.name} Design Doc of "${item.feature.title}"${item.designDoc.reason === 'SPEC_CHANGED' ? ' again, because the Spec changed what it covers' : ''}.`,
        'Approve it, decline it or Request changes in the web app: the Feature → Design Docs.',
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
    case 'REQUEST_REMINDER':
      return `${unread}Past its Response Window: ${n.decisionRequest?.title ?? 'a Decision Request'}${feature}`;
    case 'REQUEST_ESCALATED':
      return `${unread}Overdue, sent to you as Delegate: ${n.decisionRequest?.title ?? 'a Decision Request'}${feature}`;
    case 'REQUEST_OVERDUE':
      return `${unread}Overdue: ${n.decisionRequest?.title ?? 'a Decision Request'}${feature}`;
    case 'DELEGATION_STARTED':
      return `${unread}You are now the Delegate of ${n.delegation?.delegator.name ?? 'someone'} (${n.delegation ? ROLE_LABEL[n.delegation.role] : ''})`;
    case 'AI_BUDGET_WARNING':
      return `${unread}The AI's estimated cost this month passed 80% of its budget`;
    case 'AI_BUDGET_REACHED':
      return `${unread}The AI's estimated cost this month reached its budget (nothing is blocked)`;
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

export function requestLine(r: DecisionRequestView, now: Date = new Date()): string {
  const window = r.status === 'OPEN' ? windowSuffix(r.responseWindow, now) : '';
  return `[${STATUS_LABEL[r.status]}] ${kindLabel(r.kind)}: ${r.title} · ${r.featureTitle}${window}`;
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
  if (r.specProposal) {
    lines.push(
      '',
      `Spec Proposal: ${r.specProposal.status.toLowerCase()} (p opens it with the diff)`,
    );
  }
  return lines;
}

const CONTEXT = 3;

/**
 * A proposal's change as colored lines: "+" green, "-" red, unchanged dim, and long
 * unchanged runs folded to CONTEXT lines around each change (like the web's diff).
 */
export function diffView(
  base: string,
  proposed: string,
): { lines: Line[]; added: number; removed: number } {
  const diff = diffLines(base, proposed);
  const lines: Line[] = [];
  let i = 0;
  while (i < diff.length) {
    const line = diff[i];
    if (!line) break;
    if (line.kind === 'ADDED') lines.push({ text: `+ ${line.text}`, color: 'green' });
    else if (line.kind === 'REMOVED') lines.push({ text: `- ${line.text}`, color: 'red' });
    if (line.kind !== 'UNCHANGED') {
      i++;
      continue;
    }
    let end = i;
    while (end < diff.length && diff[end]?.kind === 'UNCHANGED') end++;
    const run = diff.slice(i, end).map((l) => ({ text: `  ${l.text}`, dim: true }));
    const head = i === 0 ? [] : run.slice(0, CONTEXT);
    const tail = end === diff.length ? [] : run.slice(-CONTEXT);
    if (run.length <= head.length + tail.length + 1) lines.push(...run);
    else {
      lines.push(
        ...head,
        { text: `  ⋯ ${run.length - head.length - tail.length} unchanged lines`, color: 'cyan' },
        ...tail,
      );
    }
    i = end;
  }
  return {
    lines,
    added: diff.filter((l) => l.kind === 'ADDED').length,
    removed: diff.filter((l) => l.kind === 'REMOVED').length,
  };
}

/**
 * A target Platform as a Coverage chip (ADR 0009, ticket 0052): "✓ Back-End" when covered,
 * "! Flutter" when missing. The mark, not only the colour, says which.
 */
export function coverageChip(p: PlatformCoverage): { text: string; color: string } {
  return p.covered
    ? { text: `✓ ${p.platform.name}`, color: 'green' }
    : { text: `! ${p.platform.name}`, color: 'yellow' };
}
