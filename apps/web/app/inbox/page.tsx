import type { InboxItem, InboxItemKind, NotificationList } from '@vorasaan/shared';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import type { ReactNode } from 'react';
import { KindBadge, Notice, relativeTime } from '@/components/bits';
import { MarkAllReadButton, MarkReadButton } from '@/components/notification-actions';
import { notificationHref, notificationText } from '@/components/notification-text';
import { ROLE_LABEL } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Inbox' };

type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };

async function load<T>(path: string, what: string): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await api<T>(path) };
  } catch (error) {
    unstable_rethrow(error); // let Next's redirect()/notFound() through
    return {
      ok: false,
      message:
        error instanceof ApiError ? error.message : `Something went wrong loading your ${what}.`,
    };
  }
}

/** Group order and headings: what to do first comes first. */
const GROUPS: { kind: InboxItemKind; heading: string }[] = [
  { kind: 'DECIDE', heading: 'Waiting for your decision' },
  { kind: 'CLAIM', heading: 'Sent to you, not Claimed yet' },
  { kind: 'ANSWER', heading: 'The Decider needs more info' },
  { kind: 'APPROVE_PROPOSAL', heading: 'Spec Proposals to approve' },
  { kind: 'ANSWER_GRILLING', heading: 'Grilling questions for your role' },
  { kind: 'APPROVE_BRIEF_PROPOSAL', heading: 'Brief Proposals to approve' },
];

const ROUND_LABEL = { BUSINESS: 'Business', UX: 'UX', TECHNICAL: 'Technical' } as const;

/** Where the action happens, plus what the row says. */
function describe(item: InboxItem): {
  key: string;
  href: string;
  badge: ReactNode;
  title: string;
  meta: string;
} {
  switch (item.kind) {
    case 'DECIDE':
    case 'CLAIM': {
      const r = item.decisionRequest;
      const behalf = r.onBehalfOf ? `, for ${r.onBehalfOf.name}` : '';
      return {
        key: r.id,
        href: `/requests/${r.id}`,
        badge: <KindBadge kind={r.kind} />,
        title: r.title,
        meta: `${item.feature.title}, raised by ${r.raiser.name}${behalf}`,
      };
    }
    case 'ANSWER': {
      const r = item.decisionRequest;
      return {
        key: r.id,
        href: `/requests/${r.id}`,
        badge: <KindBadge kind={r.kind} />,
        title: r.title,
        meta: item.question
          ? `${r.decider?.name ?? 'The Decider'} asks: ${item.question}`
          : `${item.feature.title}. ${r.decider?.name ?? 'The Decider'} asked for more info`,
      };
    }
    case 'APPROVE_PROPOSAL': {
      const p = item.specProposal;
      return {
        key: p.id,
        // A Decision's Proposal is reviewed with its Decision Request; others on their own page.
        href: p.decisionRequest
          ? `/requests/${p.decisionRequest.id}`
          : `/features/${item.feature.id}/proposals/${p.id}`,
        badge: <Tag>Spec Proposal</Tag>,
        title: p.decisionRequest
          ? `Spec change from “${p.decisionRequest.title}”`
          : `Spec change for ${item.feature.title}`,
        meta: item.feature.title,
      };
    }
    case 'ANSWER_GRILLING': {
      const g = item.grilling;
      return {
        key: `${g.id}:${g.round}:${g.role}`,
        // The Project page (Brief and Grilling) arrives with ticket 0035.
        href: `/projects/${item.project.id}`,
        badge: <Tag>Grilling</Tag>,
        title: `${ROUND_LABEL[g.round]} round: ${g.unanswered} question${g.unanswered === 1 ? '' : 's'} for ${ROLE_LABEL[g.role]}`,
        meta: item.project.name,
      };
    }
    case 'APPROVE_BRIEF_PROPOSAL':
      return {
        key: item.briefProposal.id,
        href: `/projects/${item.project.id}`,
        badge: <Tag>Brief Proposal</Tag>,
        title: `Brief change for ${item.project.name}`,
        meta: item.project.name,
      };
  }
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-full border border-rule px-2.5 py-0.5 text-sm text-ink-soft">
      {children}
    </span>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const { welcome } = await searchParams;
  const [inbox, notifications] = await Promise.all([
    load<InboxItem[]>('/inbox', 'Inbox'),
    load<NotificationList>('/notifications?limit=50', 'Notifications'),
  ]);

  return (
    <section className="max-w-3xl">
      {welcome && (
        <div className="mb-8">
          <Notice>
            Vorasaan is ready. Next,{' '}
            <Link href="/projects" className="text-ink underline underline-offset-2">
              create a Project
            </Link>{' '}
            and{' '}
            <Link href="/members" className="text-ink underline underline-offset-2">
              invite your team
            </Link>
            .
          </Notice>
        </div>
      )}
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>

      <div className="mt-6 space-y-10">
        {!inbox.ok ? (
          <Notice tone="error">{inbox.message}</Notice>
        ) : inbox.value.length === 0 ? (
          <p className="text-ink-soft">
            Nothing needs you right now. Decision Requests to decide, questions to answer and
            Proposals to approve will show up here.
          </p>
        ) : (
          GROUPS.map(({ kind, heading }) => {
            const items = inbox.value.filter((i) => i.kind === kind);
            if (items.length === 0) return null;
            return (
              <section key={kind} aria-labelledby={`inbox-${kind}`}>
                <h2 id={`inbox-${kind}`} className="text-lg font-semibold">
                  {heading} <span className="font-normal text-ink-soft">({items.length})</span>
                </h2>
                <ul className="mt-3 divide-y divide-rule border-y border-rule">
                  {items.map((item) => {
                    const d = describe(item);
                    return (
                      <li key={d.key}>
                        <Link
                          href={d.href}
                          className="group flex flex-col gap-1.5 py-4 sm:flex-row sm:items-start sm:gap-4"
                        >
                          <span className="shrink-0 sm:w-32">{d.badge}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium text-ink group-hover:underline">
                              {d.title}
                            </span>
                            <span className="block text-sm text-ink-soft">{d.meta}</span>
                          </span>
                          <span className="shrink-0 text-sm text-ink-soft">
                            {relativeTime(item.since)}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}

        <section id="notifications" aria-labelledby="notifications-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="notifications-heading" className="text-lg font-semibold">
              Notifications
              {notifications.ok && notifications.value.unreadCount > 0 && (
                <span className="font-normal text-ink-soft">
                  {' '}
                  ({notifications.value.unreadCount} unread)
                </span>
              )}
            </h2>
            {notifications.ok && notifications.value.unreadCount > 0 && <MarkAllReadButton />}
          </div>
          {!notifications.ok ? (
            <div className="mt-3">
              <Notice tone="error">{notifications.message}</Notice>
            </div>
          ) : notifications.value.notifications.length === 0 ? (
            <p className="mt-3 text-ink-soft">
              No Notifications yet. You'll hear here when your requests are decided or a Spec
              changes.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-rule border-y border-rule">
              {notifications.value.notifications.map((n) => {
                const text = notificationText(n);
                const href = notificationHref(n);
                const unread = n.readAt === null;
                return (
                  <li key={n.id} className="flex items-start gap-3 py-3">
                    <span
                      aria-hidden
                      className={`mt-2 size-2 shrink-0 rounded-full ${unread ? 'bg-seal' : 'bg-transparent'}`}
                    />
                    <span className="min-w-0 flex-1">
                      {unread && <span className="sr-only">Unread: </span>}
                      {href ? (
                        <Link
                          href={href}
                          className={`hover:underline ${unread ? 'font-medium text-ink' : 'text-ink-soft'}`}
                        >
                          {text}
                        </Link>
                      ) : (
                        <span className={unread ? 'font-medium text-ink' : 'text-ink-soft'}>
                          {text}
                        </span>
                      )}
                      <span className="block text-sm text-ink-soft">
                        {relativeTime(n.createdAt)}
                      </span>
                    </span>
                    {unread && <MarkReadButton id={n.id} label={`Mark read: ${text}`} />}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
