import type { DecisionGraphView } from '@vorasaan/shared';
import Link from 'next/link';

// The Design Docs' sub-lane of the Decision Graph (ticket 0069): under the main lane of Spec
// Versions, one lane per Design Doc, each approved version marked with the Spec Version it
// follows, and the draft waiting for approval at the end, dashed. A stale Design Doc says so.
// A list of links, so it reads in order and works with the keyboard and a screen reader.

export function DesignDocLanes({ graph }: { graph: DecisionGraphView }) {
  if (graph.designDocs.length === 0) return null;
  return (
    <section aria-labelledby="design-doc-lanes" className="mt-8 max-w-4xl">
      <h2 id="design-doc-lanes" className="text-lg font-semibold">
        Design Docs
      </h2>
      <p className="mt-1 text-sm text-fg-soft">
        Each Design Doc's versions, against the Spec Version each one follows.
      </p>
      <ul className="mt-3 rows">
        {graph.designDocs.map((d) => (
          <li key={d.key} className="flex flex-wrap items-center gap-3 py-3">
            <Link
              href={`/features/${graph.featureId}/design-docs/${d.key}`}
              className="w-28 shrink-0 font-medium underline-offset-2 hover:underline"
            >
              {d.name}
            </Link>
            <ol
              aria-label={`${d.name} Design Doc versions`}
              className="flex flex-wrap items-center gap-2"
            >
              {d.versions.map((v) => (
                <li
                  key={v.version}
                  className="rounded-full bg-jade-wash px-2.5 py-0.5 text-sm"
                  title={`Approved by ${v.approvedBy.name}`}
                >
                  v{v.version} · Spec v{v.specVersion}
                </li>
              ))}
              {d.pending && (
                <li className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-sm">
                  {d.pending.reason === 'FIRST_DRAFT' ? 'Draft' : 'Update'} from Spec v
                  {d.pending.specVersion}, awaiting approval
                </li>
              )}
            </ol>
            {d.stale && (
              <span className="rounded-full bg-saffron-wash px-2.5 py-0.5 text-sm font-semibold">
                Stale
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
