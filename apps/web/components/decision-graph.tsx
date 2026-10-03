'use client';

import {
  DECISION_SOURCE_LABEL,
  type DecisionGraphBranch,
  type DecisionGraphBranchState,
  type DecisionGraphNode,
  type DecisionGraphView,
} from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { type KeyboardEvent, type MouseEvent, useId, useMemo, useRef, useState } from 'react';
import { ROLE_LABEL } from '@/components/ui';
import { Tooltip } from '@/components/ui/tooltip';
import {
  type Focusable,
  type LaidBranch,
  type LaidNode,
  layoutDecisionGraph,
  moveFocus,
} from '@/lib/decision-graph-layout';

// The Decision Graph of a Feature (ticket 0067), drawn as inline SVG like a git network
// graph. Colours follow ADR 0008: jade for what was approved into the Spec, ink for a
// proposal on its way, saffron for waiting on a person, lacquer for Blockers.

const STATE_TEXT: Record<DecisionGraphBranchState, string> = {
  WAITING: 'Waiting for a decision',
  NEEDS_INFO: 'Waiting for more info from the Raiser',
  AWAITING_APPROVAL: 'Decided, Spec Proposal awaiting approval',
  MERGED: 'Decided and merged into the Spec',
  CLOSED: 'Decided without a Spec change',
  WITHDRAWN: 'Withdrawn',
};

/** What an open branch says at its end. */
const OPEN_TEXT: Partial<Record<DecisionGraphBranchState, string>> = {
  WAITING: 'waiting',
  NEEDS_INFO: 'needs info',
  AWAITING_APPROVAL: 'awaiting approval',
};

const VERSION_TEXT: Record<DecisionGraphNode['source'], string> = {
  MANUAL: 'Edited by hand',
  AI_SUMMARY: 'Drafted from Attachments',
  DECISION: 'From a Decision',
  REVERT: 'Reverted',
  CONVERSATION: 'Drafted in a Conversation',
};

/** The stroke of a branch, by where it stands. */
const STROKE: Record<DecisionGraphBranchState, string> = {
  WAITING: 'stroke-saffron',
  NEEDS_INFO: 'stroke-saffron',
  AWAITING_APPROVAL: 'stroke-ink',
  MERGED: 'stroke-jade',
  CLOSED: 'stroke-fg-faint',
  WITHDRAWN: 'stroke-fg-faint',
};
const FILL: Record<DecisionGraphBranchState, string> = {
  WAITING: 'fill-saffron',
  NEEDS_INFO: 'fill-saffron',
  AWAITING_APPROVAL: 'fill-ink',
  MERGED: 'fill-jade',
  CLOSED: 'fill-fg-faint',
  WITHDRAWN: 'fill-fg-faint',
};

const kindText = (b: DecisionGraphBranch) => (b.kind === 'BLOCKER' ? 'Blocker' : 'Question');
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "v1 → v3", "from v2, not merged", "from the empty Spec". */
function versionsText(b: DecisionGraphBranch) {
  const from = b.fromVersion === null ? 'the empty Spec' : `v${b.fromVersion}`;
  if (b.toVersion !== null) {
    return b.fromVersion === null ? `v0 → v${b.toVersion}` : `${from} → v${b.toVersion}`;
  }
  return `From ${from}, not merged`;
}

function answerText(b: DecisionGraphBranch) {
  const d = b.decision;
  if (!d) return null;
  return d.choice ? `${d.choice.label}. ${d.choice.title}` : (d.customAnswer ?? '');
}

/** What a screen reader hears for a branch: its kind, question, state and versions. */
function branchLabel(b: DecisionGraphBranch) {
  const parts = [`${kindText(b)}: ${b.title}`, STATE_TEXT[b.state], versionsText(b)];
  if (b.labels.length > 0) parts.push(b.labels.join(', '));
  return `${parts.join('. ')}.`;
}

function nodeLabel(n: DecisionGraphNode) {
  const how =
    n.source === 'REVERT' && n.revertedFrom !== null
      ? `Reverted to v${n.revertedFrom}`
      : VERSION_TEXT[n.source];
  return `Spec v${n.version}. ${how}, approved by ${n.approvedBy.name}.`;
}

function BranchDetails({ b }: { b: DecisionGraphBranch }) {
  const answer = answerText(b);
  return (
    <span className="grid gap-0.5 text-left">
      <span className="font-semibold">{b.title}</span>
      <span>
        {kindText(b)} · {STATE_TEXT[b.state]}
      </span>
      <span>Raised by {b.raiser.name}</span>
      <span>
        Decider: {b.decider?.name ?? `any ${ROLE_LABEL[b.deciderRole]}`}
        {b.decision?.onBehalfOf && ` (for ${b.decision.onBehalfOf.name})`}
      </span>
      {answer !== null && <span>Decision: {answer}</span>}
      {b.decision && (
        <span>
          Decided in {DECISION_SOURCE_LABEL[b.decision.source]}, {day(b.decision.createdAt)}
        </span>
      )}
      <span>{versionsText(b)}</span>
      {b.redrafts.length > 0 && (
        <span>
          {b.redrafts.length} Redraft{b.redrafts.length === 1 ? '' : 's'}
        </span>
      )}
      {b.labels.length > 0 && <span>{b.labels.join(' · ')}</span>}
    </span>
  );
}

function NodeDetails({ n }: { n: DecisionGraphNode }) {
  return (
    <span className="grid gap-0.5 text-left">
      <span className="font-semibold">Spec v{n.version}</span>
      {n.summary && <span>{n.summary}</span>}
      <span>
        {n.source === 'REVERT' && n.revertedFrom !== null
          ? `Reverted to v${n.revertedFrom}`
          : VERSION_TEXT[n.source]}
      </span>
      <span>
        Approved by {n.approvedBy.name}, {day(n.createdAt)}
      </span>
      <span>{n.version === 1 ? 'Opens v1' : `Opens the changes from v${n.version - 1}`}</span>
    </span>
  );
}

export function DecisionGraph({ graph }: { graph: DecisionGraphView }) {
  const router = useRouter();
  const hintId = useId();
  const layout = useMemo(() => layoutDecisionGraph(graph), [graph]);
  const refs = useRef(new Map<string, SVGAElement | HTMLAnchorElement>());

  const items: (Focusable & { href: string })[] = useMemo(
    () => [
      ...layout.nodes.map((n) => ({
        key: n.key,
        lane: 0,
        col: n.col,
        href: `/features/${graph.featureId}?tab=history&diff=${n.node.version}`,
      })),
      ...layout.branches.map((b) => ({
        key: b.key,
        lane: b.lane,
        col: b.col,
        href: `/requests/${b.branch.requestId}`,
      })),
    ],
    [layout, graph.featureId],
  );
  // One stop in the Tab order (roving tabindex): the latest Spec Version to begin with.
  const [active, setActive] = useState(() => layout.nodes.at(-1)?.key ?? items[0]?.key ?? '');
  const hrefOf = (key: string) => items.find((i) => i.key === key)?.href;

  const open = (href: string | undefined, event?: MouseEvent) => {
    if (!href) return;
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    event?.preventDefault();
    router.push(href);
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      open(hrefOf(active));
      return;
    }
    const next = moveFocus(items, active, event.key);
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    if (!next) return;
    setActive(next);
    refs.current.get(next)?.focus();
  };

  const linkProps = (key: string, label: string) => ({
    href: hrefOf(key),
    'aria-label': label,
    tabIndex: key === active ? 0 : -1,
    'data-key': key,
    className: 'group kit-quiet-focus cursor-pointer outline-none',
    ref: (el: HTMLAnchorElement | null) => {
      if (el) refs.current.set(key, el);
      else refs.current.delete(key);
    },
    onFocus: () => setActive(key),
    onClick: (event: MouseEvent) => open(hrefOf(key), event),
  });

  return (
    <div className="grid gap-3">
      <p id={hintId} className="text-sm text-fg-soft">
        Each Decision Request branches off the Spec Version current when it was sent and merges back
        at the version it produced. Use the arrow keys to move between nodes and Enter to open one.
      </p>
      <section
        aria-label="Decision Graph"
        aria-describedby={hintId}
        className="max-w-full overflow-x-auto rounded-card bg-rail"
        data-testid="decision-graph-scroll"
      >
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: the section names it, every node has its own label, and a <title> would show the browser's tooltip over the kit's */}
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block"
          onKeyDown={onKeyDown}
          data-testid="decision-graph"
        >
          {/* The main lane: the Feature's Spec. */}
          <line
            x1={layout.mainFrom}
            x2={layout.mainTo}
            y1={layout.mainY}
            y2={layout.mainY}
            className="stroke-fg-faint"
            strokeWidth={2}
            aria-hidden
          />
          {layout.origin && (
            <circle
              cx={layout.origin.x}
              cy={layout.origin.y}
              r={4}
              className="fill-rail stroke-fg-faint"
              strokeWidth={2}
              aria-hidden
            />
          )}
          {layout.branches.map((b) => (
            <BranchLine key={`line:${b.key}`} b={b} />
          ))}
          {layout.nodes.map((n) => (
            <Tooltip key={n.key} content={<NodeDetails n={n.node} />} delay={150}>
              <a {...linkProps(n.key, nodeLabel(n.node))}>
                <VersionDot n={n} />
              </a>
            </Tooltip>
          ))}
          {layout.branches.map((b) => (
            <Tooltip key={b.key} content={<BranchDetails b={b.branch} />} delay={150}>
              <a {...linkProps(b.key, branchLabel(b.branch))}>
                <RequestDot b={b} />
              </a>
            </Tooltip>
          ))}
        </svg>
      </section>
      <Legend />
    </div>
  );
}

function VersionDot({ n }: { n: LaidNode }) {
  const revert = n.node.source === 'REVERT';
  return (
    <>
      <circle cx={n.x} cy={n.y} r={14} className="fill-transparent" />
      <circle
        cx={n.x}
        cy={n.y}
        r={11}
        className="fill-none stroke-focus opacity-0 group-focus-visible:opacity-100"
        strokeWidth={2}
      />
      <circle
        cx={n.x}
        cy={n.y}
        r={7}
        className={revert ? 'fill-rail stroke-jade' : 'fill-jade stroke-rail'}
        strokeWidth={revert ? 3 : 2}
      />
      <text
        x={n.x}
        y={n.y - 14}
        textAnchor="middle"
        className="fill-fg text-[11px] font-semibold"
        aria-hidden
      >
        v{n.node.version}
      </text>
    </>
  );
}

function RequestDot({ b }: { b: LaidBranch }) {
  const blocker = b.branch.kind === 'BLOCKER';
  return (
    <>
      <circle cx={b.x} cy={b.y} r={14} className="fill-transparent" />
      <circle
        cx={b.x}
        cy={b.y}
        r={10}
        className="fill-none stroke-focus opacity-0 group-focus-visible:opacity-100"
        strokeWidth={2}
      />
      <circle
        cx={b.x}
        cy={b.y}
        r={6}
        className={`${blocker ? 'fill-lacquer' : FILL[b.branch.state]} stroke-rail`}
        strokeWidth={2}
      />
    </>
  );
}

/** The branch's line, its Redraft marks and how it ends: a merge, a closing cap, or "now". */
function BranchLine({ b }: { b: LaidBranch }) {
  const { branch } = b;
  const overdue = branch.labels.some((l) => l.startsWith('overdue'));
  const tail = OPEN_TEXT[branch.state];
  return (
    <g aria-hidden data-state={branch.state} data-testid="decision-graph-branch">
      <path
        d={b.path}
        className={`fill-none ${STROKE[branch.state]}`}
        strokeWidth={2}
        strokeDasharray={b.open ? '5 4' : undefined}
        strokeLinecap="round"
      />
      {b.marks.map((mx, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: marks are fixed for a render
          key={i}
          x1={mx}
          x2={mx}
          y1={b.y - 5}
          y2={b.y + 5}
          className="stroke-ink"
          strokeWidth={2}
          data-testid="redraft-mark"
        />
      ))}
      {!b.open && branch.toVersion === null && (
        <line
          x1={b.endX}
          x2={b.endX}
          y1={b.y - 6}
          y2={b.y + 6}
          className="stroke-fg-soft"
          strokeWidth={2}
        />
      )}
      {b.open && tail && (
        <text
          x={b.endX + 8}
          y={b.y + 4}
          className={`text-[11px] ${overdue ? 'fill-lacquer' : 'fill-fg-soft'}`}
        >
          {[tail, ...branch.labels].join(' · ')}
        </text>
      )}
    </g>
  );
}

function Legend() {
  const swatch = (className: string, dashed = false) => (
    <svg width="22" height="10" aria-hidden className="shrink-0">
      <line
        x1="1"
        x2="21"
        y1="5"
        y2="5"
        className={className}
        strokeWidth={2}
        strokeDasharray={dashed ? '5 4' : undefined}
      />
    </svg>
  );
  const dot = (className: string) => (
    <svg width="12" height="12" aria-hidden className="shrink-0">
      <circle cx="6" cy="6" r="5" className={className} />
    </svg>
  );
  const items = [
    [swatch('stroke-jade'), 'Merged into the Spec'],
    [swatch('stroke-ink', true), 'Spec Proposal awaiting approval'],
    [swatch('stroke-saffron', true), 'Waiting for a person'],
    [swatch('stroke-fg-faint'), 'Closed without a Spec change'],
    [dot('fill-lacquer'), 'Blocker'],
    [
      <svg key="mark" width="12" height="12" aria-hidden className="shrink-0">
        <line x1="6" x2="6" y1="1" y2="11" className="stroke-ink" strokeWidth={2} />
      </svg>,
      'Redraft',
    ],
  ] as const;
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-fg-soft">
      {items.map(([icon, text]) => (
        <li key={text} className="inline-flex items-center gap-2">
          {icon}
          {text}
        </li>
      ))}
    </ul>
  );
}
