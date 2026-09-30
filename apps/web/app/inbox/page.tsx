import type { DecisionRequestView } from '@vorasaan/shared';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { KindBadge, Notice, relativeTime } from '@/components/bits';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Inbox' };

export default async function InboxPage() {
  let requests: DecisionRequestView[];
  try {
    requests = await api<DecisionRequestView[]>('/decision-requests?decider=me&status=OPEN');
  } catch (error) {
    unstable_rethrow(error); // let Next's redirect()/notFound() through
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Something went wrong loading your Inbox.'}
      </Notice>
    );
  }

  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Waiting for your decision</h1>
      {requests.length === 0 ? (
        <p className="mt-6 text-ink-soft">
          Nothing needs your decision right now. Blockers and Questions routed to you will show up
          here.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-rule border-y border-rule">
          {requests.map((r) => (
            <li key={r.id}>
              <Link
                href={`/requests/${r.id}`}
                className="group flex flex-col gap-1.5 py-4 sm:flex-row sm:items-start sm:gap-4"
              >
                <span className="shrink-0 sm:w-28">
                  <KindBadge kind={r.kind} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink group-hover:underline">
                    {r.title}
                  </span>
                  <span className="block text-sm text-ink-soft">
                    {r.featureTitle}, raised by {r.raiser.name}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-ink-soft">
                  {relativeTime(r.submittedAt ?? r.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
