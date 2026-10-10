'use client';

import { type CoverageGap, coverageGapText, type PlatformCoverage } from '@vorasaan/shared';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  Dialog as AriaDialog,
  Tooltip as AriaTooltip,
  DialogTrigger,
  TooltipTrigger,
} from 'react-aria-components';
import { draftAcceptanceCriteria } from '@/lib/platform-actions';
import { CheckIcon } from './icons';
import { Button } from './ui/button';
import { PopoverSurface } from './ui/popover';
import { tooltipClass } from './ui/tooltip';

// A Feature's target Platforms as Coverage chips (ADR 0009, ticket 0052): jade when covered,
// saffron when missing. Hovering or focusing one shows why; pressing it (a tap on a phone)
// opens the reasons with what can be done about them. Text stays the foreground colour on
// the tinted chips, so it keeps its contrast; the icon carries the colour.

/** The reasons a Platform is missing, in words, or that it is covered. */
export function coverageSummary(p: PlatformCoverage): string {
  if (p.covered) {
    return p.checks.length
      ? `${p.platform.name} is covered: every check it switches on passes.`
      : `${p.platform.name} switches every check off.`;
  }
  return p.missing.map(coverageGapText).join('. ');
}

export function MissingIcon() {
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-full bg-saffron text-[11px] font-bold leading-none text-bg"
    >
      !
    </span>
  );
}

export function CoveredIcon() {
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-full bg-jade text-bg"
    >
      <CheckIcon size={12} />
    </span>
  );
}

/** The classes of a Coverage chip, covered or missing. */
export const chipClass = (covered: boolean) =>
  `inline-flex items-center gap-1.5 rounded-full px-3 py-0.5 text-sm text-fg ${
    covered ? 'bg-jade-wash' : 'bg-saffron-wash'
  }`;

function GapDetail({
  gap,
  platform,
  featureId,
  canDraft,
  onDraft,
  drafting,
}: {
  gap: CoverageGap;
  platform: PlatformCoverage['platform'];
  featureId: string;
  canDraft: boolean;
  onDraft: () => void;
  drafting: boolean;
}) {
  return (
    <li className="py-1.5">
      <span className="block">{coverageGapText(gap)}</span>
      {gap.check === 'SPEC_SECTION' && canDraft && (
        <Link
          href={`/conversations/new?feature=${featureId}&section=${encodeURIComponent(platform.name)}`}
          className="mt-1 inline-block text-sm font-medium underline underline-offset-2"
        >
          Ask the AI to add a {platform.name} section
        </Link>
      )}
      {gap.check === 'NO_OPEN_BLOCKERS' && (
        <ul className="mt-1 text-sm">
          {gap.blockers.map((b) => (
            <li key={b.id}>
              <Link href={`/requests/${b.id}`} className="underline underline-offset-2">
                {b.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {gap.check === 'QA_READY' && gap.noCriteria && canDraft && (
        <Button size="sm" className="mt-1.5" isDisabled={drafting} onPress={onDraft}>
          {drafting ? 'Drafting…' : 'Draft acceptance criteria'}
        </Button>
      )}
    </li>
  );
}

/**
 * One chip per target Platform. `canDraft`: the Feature's PO or an Admin, who may ask the AI
 * for a missing section or acceptance criteria (both become proposals they approve).
 */
export function CoverageChips({
  featureId,
  platforms,
  canDraft,
}: {
  featureId: string;
  platforms: PlatformCoverage[];
  canDraft: boolean;
}) {
  // Outside the popovers, so the result is still announced once a popover closes.
  const [status, setStatus] = useState<{ ok: boolean; text: string; proposalId?: string }>();
  const [drafting, start] = useTransition();

  const draft = (p: PlatformCoverage) =>
    start(async () => {
      setStatus({ ok: true, text: `Drafting ${p.platform.name}'s acceptance criteria…` });
      const result = await draftAcceptanceCriteria(featureId, p.platform.id);
      setStatus(
        result.error
          ? { ok: false, text: result.error }
          : {
              ok: true,
              text: `The AI drafted ${p.platform.name}'s acceptance criteria as a Spec Proposal.`,
              proposalId: result.proposalId,
            },
      );
    });

  if (platforms.length === 0) return null;
  return (
    <div className="mt-2">
      <ul aria-label="Target Platforms" className="flex flex-wrap gap-2">
        {platforms.map((p) => {
          const state = p.covered ? 'covered' : 'missing';
          return (
            <li key={p.platform.id}>
              <DialogTrigger>
                <TooltipTrigger delay={300}>
                  <Button
                    aria-label={`${p.platform.name}: ${state}`}
                    className={`${chipClass(p.covered)} font-normal!`}
                    size="sm"
                  >
                    {p.covered ? <CoveredIcon /> : <MissingIcon />}
                    {p.platform.name}
                  </Button>
                  <AriaTooltip placement="bottom" offset={6} className={`max-w-64 ${tooltipClass}`}>
                    {coverageSummary(p)}
                  </AriaTooltip>
                </TooltipTrigger>
                <PopoverSurface placement="bottom start" className="max-w-sm">
                  <AriaDialog
                    aria-label={`${p.platform.name} Coverage`}
                    className="p-2.5 outline-none"
                  >
                    <p className="font-semibold">
                      {p.platform.name}: {state}
                    </p>
                    {p.covered ? (
                      <p className="mt-1 text-sm text-fg-soft">{coverageSummary(p)}</p>
                    ) : (
                      <ul className="mt-1">
                        {p.missing.map((gap) => (
                          <GapDetail
                            key={gap.check}
                            gap={gap}
                            platform={p.platform}
                            featureId={featureId}
                            canDraft={canDraft}
                            drafting={drafting}
                            onDraft={() => draft(p)}
                          />
                        ))}
                      </ul>
                    )}
                  </AriaDialog>
                </PopoverSurface>
              </DialogTrigger>
            </li>
          );
        })}
      </ul>
      <p
        role="status"
        className={`mt-2 text-sm empty:hidden ${status?.ok === false ? 'text-lacquer' : 'text-fg-soft'}`}
      >
        {status?.text}
        {status?.proposalId && (
          <>
            {' '}
            <Link
              href={`/features/${featureId}/proposals/${status.proposalId}`}
              className="font-medium text-fg underline underline-offset-2"
            >
              Review it
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
