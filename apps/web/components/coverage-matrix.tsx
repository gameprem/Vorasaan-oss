'use client';

import {
  type CoverageCheck,
  coverageGapText,
  type FeatureCoverageRow,
  type PlatformCoverage,
  type ProjectCoverageView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { useState } from 'react';
import { CoveredIcon, MissingIcon } from './coverage-chips';
import { Select } from './ui/select';
import { Switch } from './ui/switch';

// A Project's Coverage (ADR 0009, ticket 0052): a Feature × Platform matrix, filterable to
// what is missing and why, so QA can see which Platforms still need test cases. On a phone the
// matrix scrolls inside its own region; the page never scrolls sideways.

const ANY = 'ANY';

/** The reasons a Platform can be missing, as the filter names them. */
export const REASONS: { id: CoverageCheck; label: string }[] = [
  { id: 'SPEC_SECTION', label: 'No Spec section' },
  { id: 'SOMEONE_TO_ASK', label: 'Nobody to ask' },
  { id: 'NO_OPEN_BLOCKERS', label: 'Open Blockers' },
  { id: 'QA_READY', label: 'Missing QA' },
];

const isReason = (value: string | undefined): value is CoverageCheck =>
  REASONS.some((r) => r.id === value);

/** Whether a cell is missing, and for `reason` when one is picked. */
function matches(cell: PlatformCoverage, reason: CoverageCheck | null): boolean {
  if (cell.covered) return false;
  return reason === null || cell.missing.some((gap) => gap.check === reason);
}

function Cell({ cell }: { cell: PlatformCoverage | undefined }) {
  if (!cell) return <span className="text-sm text-fg-soft">Not targeted</span>;
  if (cell.covered) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <CoveredIcon />
        Covered
      </span>
    );
  }
  return (
    <div>
      <span className="inline-flex items-center gap-1.5 font-medium">
        <MissingIcon />
        Missing
      </span>
      <ul className="mt-1 space-y-0.5 text-sm text-fg-soft">
        {cell.missing.map((gap) => (
          <li key={gap.check}>{coverageGapText(gap)}</li>
        ))}
      </ul>
    </div>
  );
}

export function CoverageMatrix({
  coverage,
  initialMissingOnly = false,
  initialReason,
}: {
  coverage: ProjectCoverageView;
  initialMissingOnly?: boolean;
  initialReason?: string;
}) {
  const [missingOnly, setMissingOnly] = useState(initialMissingOnly);
  const [reason, setReason] = useState<CoverageCheck | null>(
    isReason(initialReason) ? initialReason : null,
  );

  // Keep the filters in the address, so a filtered view can be shared or reloaded.
  const remember = (next: { missing: boolean; reason: CoverageCheck | null }) => {
    const url = new URL(window.location.href);
    if (next.missing) url.searchParams.set('missing', '1');
    else url.searchParams.delete('missing');
    if (next.reason) url.searchParams.set('reason', next.reason);
    else url.searchParams.delete('reason');
    window.history.replaceState(null, '', url);
  };

  const filtering = missingOnly || reason !== null;
  const rows: FeatureCoverageRow[] = filtering
    ? coverage.features.filter((f) => f.platforms.some((c) => matches(c, reason)))
    : coverage.features;
  const { platforms, uncovered } = coverage;

  if (coverage.features.length === 0) {
    return <p className="text-fg-soft">No Features in this Project yet.</p>;
  }

  return (
    <div>
      {platforms.length > 0 && (
        <p className="text-fg-soft">
          {uncovered.length === 0
            ? 'Every Platform is covered by at least one Feature.'
            : `No Feature covers ${uncovered.map((p) => p.name).join(', ')} yet.`}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-end gap-6">
        <Switch
          isSelected={missingOnly}
          onChange={(on) => {
            setMissingOnly(on);
            remember({ missing: on, reason });
          }}
        >
          Missing only
        </Switch>
        <Select
          label="Reason"
          className="w-56"
          options={[
            { id: ANY, label: 'Any reason' },
            ...REASONS.map((r) => ({ id: r.id, label: r.label })),
          ]}
          value={reason ?? ANY}
          onChange={(value) => {
            const next = isReason(value) ? value : null;
            setReason(next);
            remember({ missing: missingOnly, reason: next });
          }}
        />
      </div>

      <p role="status" className="mt-4 text-sm text-fg-soft">
        {filtering
          ? `Showing ${rows.length} of ${coverage.features.length} Features`
          : `${coverage.features.length} Features`}
      </p>

      <section
        aria-label="Coverage matrix"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard (axe: scrollable-region-focusable)
        tabIndex={0}
        className="mt-3 max-w-full overflow-x-auto rounded-card bg-rail outline-none focus-visible:outline-2 focus-visible:outline-focus"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-left">
          <caption className="sr-only">Coverage of each Feature on each Platform</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 bg-rail px-4 py-3 text-sm font-semibold">
                Feature
              </th>
              {platforms.map((p) => (
                <th key={p.id} scope="col" className="px-4 py-3 text-sm font-semibold">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={platforms.length + 1} className="px-4 py-6 text-fg-soft">
                  No Feature is missing that.
                </td>
              </tr>
            ) : (
              rows.map((f) => {
                const byPlatform = new Map(f.platforms.map((c) => [c.platform.id, c]));
                return (
                  <tr key={f.featureId} className="align-top">
                    <th
                      scope="row"
                      className="sticky left-0 w-44 max-w-44 bg-rail px-4 py-3 font-normal"
                    >
                      <Link
                        href={`/features/${f.featureId}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {f.title}
                      </Link>
                      <span className="block text-sm text-fg-soft">{f.teamName} team</span>
                    </th>
                    {platforms.map((p) => (
                      <td key={p.id} className="w-56 min-w-48 px-4 py-3">
                        <Cell cell={byPlatform.get(p.id)} />
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
