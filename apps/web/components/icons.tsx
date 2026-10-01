// The shell's line icons, drawn like the mockup's (docs/design/chat-web-ui-mockup.html).
// Decorative: the control around each one carries the accessible name.

type IconProps = { size?: number };

const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** The AI's spark, ink → jade: a proposal on its way to approval. */
export function Spark({ size = 24, className }: IconProps & { className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--spark-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--spark-b)' }} />
        </linearGradient>
      </defs>
      <path
        fill="url(#spark-grad)"
        d="M12 2c.5 4.9 2.9 8.6 10 10-7.1 1.4-9.5 5.1-10 10-.5-4.9-2.9-8.6-10-10 7.1-1.4 9.5-5.1 10-10Z"
      />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v10M3 8h10" {...stroke} strokeWidth={1.6} />
    </svg>
  );
}

export function InboxIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 9l1.6-5.2A1 1 0 0 1 4.6 3h6.8a1 1 0 0 1 1 .8L14 9v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9Zm0 0h3.5l1 1.5h3L10.5 9H14"
        {...stroke}
        strokeWidth={1.3}
      />
    </svg>
  );
}

/** My Requests: a paper plane, what I sent. */
export function SentIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M14 2 2 7l5 2 2 5 5-12ZM7 9l3-3" {...stroke} strokeWidth={1.3} />
    </svg>
  );
}

export function GearIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="2.2" {...stroke} strokeWidth={1.3} />
      <path
        d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"
        {...stroke}
        strokeWidth={1.3}
      />
    </svg>
  );
}

export function CaretIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="m4.5 3 3 3-3 3" {...stroke} strokeWidth={1.5} />
    </svg>
  );
}

export function MenuIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3 5h14M3 10h14M3 15h14" {...stroke} strokeWidth={1.6} />
    </svg>
  );
}

/** Collapse or expand the Sidebar: a panel with its rail. */
export function PanelIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2.5" y="3.5" width="15" height="13" rx="3" {...stroke} />
      <path d="M8 3.5v13" {...stroke} />
    </svg>
  );
}

export function CloseIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M5 5l10 10M15 5 5 15" {...stroke} strokeWidth={1.6} />
    </svg>
  );
}

export function BackIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M10 3 5 8l5 5" {...stroke} strokeWidth={1.7} />
    </svg>
  );
}
