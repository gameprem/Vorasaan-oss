'use client';

import type { ReactNode } from 'react';
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type Key,
  MenuTrigger,
  Separator,
} from 'react-aria-components';
import { Button, type ButtonVariant } from './button';
import { PopoverSurface } from './popover';

export type MenuAction = {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  /** A link instead of an action. */
  href?: string;
  isDisabled?: boolean;
  /** Draw a gap above this item. */
  separatorBefore?: boolean;
  tone?: 'default' | 'danger';
};

/** A button that opens a list of actions. */
export function Menu({
  trigger,
  'aria-label': ariaLabel,
  actions,
  onAction,
  variant = 'secondary',
  placement = 'bottom start',
}: {
  /** The content of the button. */
  trigger: ReactNode;
  /** The button's name, when `trigger` is only an icon. */
  'aria-label'?: string;
  actions: MenuAction[];
  onAction?: (id: string) => void;
  variant?: ButtonVariant;
  placement?: 'bottom start' | 'bottom end' | 'top start' | 'top end';
}) {
  return (
    <MenuTrigger>
      <Button variant={variant} aria-label={ariaLabel}>
        {trigger}
      </Button>
      <PopoverSurface placement={placement} className="min-w-48">
        <AriaMenu
          onAction={(key: Key) => onAction?.(String(key))}
          className="grid gap-0.5 outline-none"
        >
          {actions.flatMap((a) => [
            ...(a.separatorBefore
              ? [<Separator key={`${a.id}-sep`} className="mx-2 my-1 h-0.5 bg-surface" />]
              : []),
            <AriaMenuItem
              key={a.id}
              id={a.id}
              href={a.href}
              textValue={a.label}
              isDisabled={a.isDisabled}
              className={`kit-quiet-focus flex cursor-default items-center gap-3 rounded-[14px] px-3 py-2 outline-none data-[disabled]:opacity-40 data-[focused]:bg-surface ${
                a.tone === 'danger' ? 'text-lacquer' : 'text-fg'
              }`}
            >
              {a.icon && (
                <span aria-hidden className="flex shrink-0 text-fg-soft">
                  {a.icon}
                </span>
              )}
              <span className="min-w-0">
                <span className="block">{a.label}</span>
                {a.description && (
                  <span className="block text-xs text-fg-soft">{a.description}</span>
                )}
              </span>
            </AriaMenuItem>,
          ])}
        </AriaMenu>
      </PopoverSurface>
    </MenuTrigger>
  );
}
