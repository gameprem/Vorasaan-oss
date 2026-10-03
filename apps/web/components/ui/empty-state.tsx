import type { ReactNode } from 'react';

/** What a list or page says when there is nothing in it yet, and what to do about it. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  /** One or two sentences under the title. */
  children?: ReactNode;
  /** A button or link to start. */
  action?: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-2 rounded-card bg-rail px-6 py-10 text-center">
      {icon && (
        <span
          aria-hidden
          className="mb-1 grid size-12 place-items-center rounded-full bg-bg text-ink"
        >
          {icon}
        </span>
      )}
      <p className="font-semibold text-fg">{title}</p>
      {children && <div className="max-w-[48ch] text-fg-soft">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
