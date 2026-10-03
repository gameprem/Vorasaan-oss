'use client';

import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';

// A pill button (ADR 0008). The kit's triggers use it; plain forms may keep the class
// names in components/ui.ts.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-on-ink data-[hovered]:opacity-90',
  secondary: 'bg-surface text-fg data-[hovered]:bg-surface-hi',
  ghost: 'text-fg-soft data-[hovered]:bg-surface-hi data-[hovered]:text-fg',
  danger: 'bg-lacquer-wash text-lacquer data-[hovered]:opacity-90',
};

export const buttonClass = (variant: ButtonVariant = 'secondary', size: 'md' | 'sm' = 'md') =>
  `inline-flex items-center justify-center gap-2 rounded-full font-semibold outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 ${
    size === 'sm' ? 'px-3 py-1 text-sm' : 'px-4 py-2'
  } ${VARIANT[variant]}`;

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: Omit<AriaButtonProps, 'className'> & {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  className?: string;
}) {
  return <AriaButton {...props} className={`${buttonClass(variant, size)} ${className ?? ''}`} />;
}
