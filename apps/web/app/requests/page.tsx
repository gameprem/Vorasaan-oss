import type { DecisionRequestStatus, DecisionRequestView } from '@vorasaan/shared';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { KindBadge, Notice, relativeTime, statusText } from '@/components/bits';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'My Requests' };

const WAITING: DecisionRequestStatus[] = ['DRAFT', 'OPEN', 'NEEDS_INFO'];

export default async function MyRequestsPage() {
  let requests: DecisionRequestView[];
  try {
    requests = await api<DecisionRequestView[]>('/decision-requests?raiser=me');
  } catch (error) {
    unstable_rethrow(error); // let Next's redirect()/notFound() through
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Something went wrong loading your requests.'}
      </Notice>
    );
  }
  const newest = (a: DecisionRequestView, b: DecisionRequestView) =>
    (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt);
  const open = requests.filter((r) => WAITING.includes(r.status)).sort(newest);
  const closed = requests.filter((r) => !WAITING.includes(r.status)).sort(newest);

  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">My Requests</h1>
      <p className="mt-1 text-fg-soft">Decision Requests you raised, and where each one stands.</p>
      {requests.length === 0 ? (
        <p className="mt-6 text-fg-soft">
          You haven't raised any Decision Requests yet. Raise a Blocker or a Question from a
          Feature's page.
        </p>
      ) : (
        <div className="mt-6 space-y-10">
          <RequestGroup id="waiting" heading="In progress" requests={open} />
          <RequestGroup id="closed" heading="Closed" requests={closed} />
        </div>
      )}
    </section>
  );
}

function RequestGroup({
  id,
  heading,
  requests,
}: {
  id: string;
  heading: string;
  requests: DecisionRequestView[];
}) {
  if (requests.length === 0) return null;
  return (
    <section aria-labelledby={`requests-${id}`}>
      <h2 id={`requests-${id}`} className="text-lg font-semibold">
        {heading} <span className="font-normal text-fg-soft">({requests.length})</span>
      </h2>
      <ul className="mt-3 rows">
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
                <span className="block font-medium text-fg group-hover:underline">{r.title}</span>
                <span className="block text-sm text-fg-soft">
                  {r.featureTitle}. {statusText(r.status)}
                  {r.decider && r.status !== 'DRAFT' ? `, Decider ${r.decider.name}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-sm text-fg-soft">
                {relativeTime(r.submittedAt ?? r.createdAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
