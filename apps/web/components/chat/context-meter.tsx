'use client';

import type { ConversationUsage } from '@vorasaan/shared';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  Tooltip as AriaTooltip,
  DialogTrigger,
  TooltipTrigger,
} from 'react-aria-components';
import { Button } from '../ui/button';
import { PopoverSurface } from '../ui/popover';
import { tooltipClass } from '../ui/tooltip';

// The context meter (ticket 0066, ADR 0012), next to the model picker: how full the
// Conversation's history share is, from the server's own budget plan for the model the
// next reply runs on. It turns saffron near the compaction threshold and lacquer past
// it. Hovering shows the shares; pressing opens them with "Compact now".

/** "12.3k", "850", "1M": tokens, short. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}
const trim = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '');

export type MeterLevel = 'ok' | 'warn' | 'full';

export function meterLevel(usage: ConversationUsage): MeterLevel {
  const { used, warnAt, compactAt } = usage.history;
  if (used >= compactAt) return 'full';
  if (used >= warnAt) return 'warn';
  return 'ok';
}

/** What the meter's button reads out, numbers included. */
export function meterLabel(usage: ConversationUsage): string {
  const percent = Math.round(usage.history.fraction * 100);
  const at = Math.round((usage.history.compactAt / Math.max(1, usage.history.share)) * 100);
  const level = meterLevel(usage);
  const state =
    level === 'full'
      ? ' The next message compacts it first.'
      : level === 'warn'
        ? ' Compaction is near.'
        : '';
  return `Context: ${percent}% of the history share used (${tokens(usage.history.used)} of ${tokens(usage.history.share)} tokens). It compacts at ${at}%.${state}`;
}

function Breakdown({ usage }: { usage: ConversationUsage }) {
  const { plan, history, lastTurn } = usage;
  return (
    <>
      <dl className="meter-rows">
        <dt>Foundation and system prompt</dt>
        <dd>{tokens(plan.system + plan.foundation)}</dd>
        <dt>Retrieved context</dt>
        <dd>{tokens(plan.context)}</dd>
        <dt>History</dt>
        <dd>
          {tokens(history.used)} / {tokens(plan.history)}
        </dd>
        <dt>Room for the reply</dt>
        <dd>{tokens(plan.reply)}</dd>
        <dt>Context Window</dt>
        <dd>{tokens(usage.contextWindow)}</dd>
        <dt>Last turn read from cache</dt>
        <dd>
          {lastTurn?.cacheReadTokens == null
            ? '—'
            : `${tokens(lastTurn.cacheReadTokens)}${
                lastTurn.inputTokens ? ` of ${tokens(lastTurn.inputTokens)}` : ''
              }`}
        </dd>
      </dl>
      <p className="meter-note">
        {usage.model.displayName ?? usage.model.modelId} · compacts at {tokens(history.compactAt)}{' '}
        tokens of history
      </p>
    </>
  );
}

export function ContextMeter({
  usage,
  onCompact,
  compacting,
  canCompact,
}: {
  usage: ConversationUsage | null;
  onCompact: () => void;
  compacting: boolean;
  /** Whether a compaction may start now (not while a reply is written). */
  canCompact: boolean;
}) {
  if (!usage) return null;
  const level = meterLevel(usage);
  const fill = Math.min(1, usage.history.fraction);
  const percent = Math.round(usage.history.fraction * 100);
  return (
    <DialogTrigger>
      {/* The kit's Tooltip wraps a plain element; a React Aria Button takes the trigger itself. */}
      <TooltipTrigger delay={300}>
        <AriaButton
          className="meter-btn kit-quiet-focus"
          data-level={level}
          aria-label={meterLabel(usage)}
        >
          <span aria-hidden className="meter-ring" style={{ ['--fill' as string]: fill }} />
          <span aria-hidden>{percent}%</span>
        </AriaButton>
        <AriaTooltip placement="top" offset={6} className={`${tooltipClass} max-w-80`}>
          <span className="meter-panel meter-tip">
            <Breakdown usage={usage} />
          </span>
        </AriaTooltip>
      </TooltipTrigger>
      <PopoverSurface placement="top start" className="max-w-sm">
        <AriaDialog aria-label="Context" className="p-2.5 outline-none">
          {({ close }) => (
            <div className="meter-panel" data-level={level}>
              <h3>Context · {percent}% of the history share</h3>
              <div className="meter-bar">
                <span style={{ width: `${fill * 100}%` }} />
              </div>
              <Breakdown usage={usage} />
              <p className="meter-note">
                Compacting folds the older messages into the Conversation Summary the AI reads. They
                stay here to read. Type <code>/compact</code> and what to keep to steer it.
              </p>
              <Button
                variant="primary"
                size="sm"
                isDisabled={!canCompact || compacting}
                onPress={() => {
                  close();
                  onCompact();
                }}
              >
                {compacting ? 'Compacting…' : 'Compact now'}
              </Button>
            </div>
          )}
        </AriaDialog>
      </PopoverSurface>
    </DialogTrigger>
  );
}
