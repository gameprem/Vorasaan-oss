'use client';

import type { DOMAttributes, ReactElement, ReactNode } from 'react';
import { Tooltip as AriaTooltip, Focusable, TooltipTrigger } from 'react-aria-components';

/**
 * A short hint on hover or keyboard focus. `children` must be one focusable element (a
 * button or link) that can take a ref; the hint never holds anything interactive.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 500,
}: {
  content: ReactNode;
  children: ReactElement<DOMAttributes<HTMLElement>, string>;
  placement?: 'top' | 'bottom' | 'start' | 'end';
  delay?: number;
}) {
  return (
    <TooltipTrigger delay={delay}>
      <Focusable>{children}</Focusable>
      <AriaTooltip
        placement={placement}
        offset={6}
        className="max-w-64 rounded-tile bg-fg px-2.5 py-1.5 text-sm text-bg shadow-card data-[entering]:animate-[pop-in_120ms_ease-out]"
      >
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
