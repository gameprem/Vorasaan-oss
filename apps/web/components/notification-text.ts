import type { NotificationView } from '@vorasaan/shared';
import { ROLE_LABEL } from './ui';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** One sentence describing a Notification (used on screen and by the live region). */
export function notificationText(n: NotificationView): string {
  const title = n.decisionRequest ? `“${n.decisionRequest.title}”` : 'A Decision Request';
  switch (n.type) {
    case 'REQUEST_DECIDED':
      return `${title} was decided.`;
    case 'REQUEST_CLAIMED':
      return `${title} was Claimed.`;
    case 'REQUEST_WITHDRAWN':
      return `${title} was withdrawn.`;
    case 'REQUEST_REMINDER':
      return `${title} is past its Response Window and waits for your decision.`;
    case 'REQUEST_ESCALATED':
      return `${title} is overdue and was sent to you as a Delegate. You can Claim it.`;
    case 'REQUEST_OVERDUE':
      return `${title} is overdue. Reassign it, or decide whether to wait.`;
    case 'SPEC_VERSION_CREATED':
      return n.specVersion
        ? `Spec v${n.specVersion.version}${n.feature ? ` of ${n.feature.title}` : ''} was approved by ${n.specVersion.approvedBy.name}.`
        : 'A new Spec Version was approved.';
    case 'DELEGATION_STARTED':
      return n.delegation
        ? `${n.delegation.delegator.name} delegated their ${ROLE_LABEL[n.delegation.role]} role to you until ${dateFmt.format(new Date(n.delegation.endsAt))}.`
        : 'A Delegation to you has started.';
  }
}

/** Where a Notification's link goes. */
export function notificationHref(n: NotificationView): string | null {
  if (n.decisionRequest) return `/requests/${n.decisionRequest.id}`;
  if (n.type === 'SPEC_VERSION_CREATED' && n.feature)
    return `/features/${n.feature.id}?tab=history`;
  if (n.delegation) return `/teams/${n.delegation.teamId}`;
  if (n.feature) return `/features/${n.feature.id}`;
  return null;
}
