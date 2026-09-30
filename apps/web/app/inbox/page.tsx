import type { DecisionRequestView } from '@vorasaan/shared';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { KindBadge, Notice, relativeTime } from '@/components/bits';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Inbox' };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const { welcome } = await searchParams;
  let requests: DecisionRequestView[];
  try {
    // Routed to me, plus those sent to several people (me included) that nobody has Claimed.
    const [mine, sentToMe] = await Promise.all([
      api<DecisionRequestView[]>('/decision-requests?decider=me&status=OPEN'),
      api<DecisionRequestView[]>('/decision-requests?recipient=me'),
    ]);
    requests = [...mine, ...sentToMe.filter((r) => !mine.some((m) => m.id === r.id))].sort((a, b) =>
      (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt),
    );
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
                    {r.decider ? '' : '. Not Claimed yet'}
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
