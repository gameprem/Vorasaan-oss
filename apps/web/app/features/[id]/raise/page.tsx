import type { FeatureSummaryView } from '@vorasaan/shared';
import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';
import { Notice } from '@/components/bits';
import { RaiseForm } from '@/components/raise-form';
import { ApiError, api } from '@/lib/api';

export const metadata = { title: 'Raise a Decision Request' };

export default async function RaisePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let feature: FeatureSummaryView;
  try {
    feature = await api<FeatureSummaryView>(`/features/${id}`);
  } catch (error) {
    unstable_rethrow(error); // let Next's redirect()/notFound() through
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    return (
      <Notice tone="error">
        {error instanceof ApiError ? error.message : 'Could not load this Feature.'}
      </Notice>
    );
  }

  return (
    <section className="max-w-3xl">
      <p className="text-sm text-fg-soft">
        <Link href={`/features/${id}`} className="underline-offset-2 hover:underline">
          {feature.title}
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Raise a Decision Request</h1>
      <div className="mt-6">
        {feature.myRoles.length === 0 ? (
          <Notice>
            Only a Role Owner of this Feature can raise a Decision Request. Ask the Team's PO to add
            you as one.
          </Notice>
        ) : (
          <RaiseForm featureId={id} />
        )}
      </div>
    </section>
  );
}
