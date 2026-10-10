'use client';

import type { ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
  DialogTrigger,
} from 'react-aria-components';
import { Button, type ButtonVariant } from './button';

/** The floating surface of every menu, list and picker: tonal, rounded, a soft shadow. */
export const popoverSurface =
  'rounded-card bg-bg p-1.5 text-fg shadow-card ring-1 ring-line/60 outline-none data-[entering]:animate-[pop-in_120ms_ease-out] data-[exiting]:animate-[pop-in_90ms_ease-in_reverse]';

/** The raw styled popover, for the kit's own pickers. */
export function PopoverSurface({ className, ...props }: AriaPopoverProps & { className?: string }) {
  return (
    <AriaPopover
      offset={6}
      {...props}
      className={`${popoverSurface} max-h-[min(60vh,420px)] overflow-auto ${className ?? ''}`}
    />
  );
}

/** A button that opens a small panel of anything: filters, a hint, a short form. */
export function Popover({
  trigger,
  variant = 'secondary',
  title,
  children,
  placement = 'bottom start',
}: {
  /** The content of the button that opens it. */
  trigger: ReactNode;
  variant?: ButtonVariant;
  /** Names the panel for screen readers. */
  title: string;
  children: ReactNode;
  placement?: AriaPopoverProps['placement'];
}) {
  return (
    <DialogTrigger>
      <Button variant={variant}>{trigger}</Button>
      <PopoverSurface placement={placement} className="max-w-sm">
        <AriaDialog aria-label={title} className="p-2.5 outline-none">
          {children}
        </AriaDialog>
      </PopoverSurface>
    </DialogTrigger>
  );
}
