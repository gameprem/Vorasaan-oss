// The shell's line icons, drawn like the mockup's (docs/design/chat-web-ui-mockup.html).
// Decorative: the control around each one carries the accessible name.

type IconProps = { size?: number };

const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/**
 * The Vorasaan mark: a person's tongs hold the AI's flame over the grill.
 * The AI brings the heat; a person decides where it goes (ADR 0008).
 */
export function Logo({ size = 24, className }: IconProps & { className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden
      className={className}
    >
      <path d="M8 37h32M11 43h26" stroke="var(--fg)" strokeWidth={3} strokeLinecap="round" />
      <path
        d="M24 30c-4.2 0-7-2.9-7-6.4 0-3.9 3.3-5.6 4.2-9.6 2.6 2 3.7 4 3.7 6 1.3-.8 2.1-2.1 2.4-3.6 2.3 1.9 3.7 4.3 3.7 7.2 0 3.6-3 6.4-7 6.4Z"
        fill="var(--ember)"
      />
      <path
        d="M24 30c-2.1 0-3.4-1.4-3.4-3.1 0-1.9 1.6-2.8 2.1-4.7 1.3 1 1.8 2 1.8 3 .7-.4 1-1 1.2-1.8 1.1.9 1.8 2.1 1.8 3.5 0 1.8-1.5 3.1-3.5 3.1Z"
        fill="var(--saffron)"
      />
      <path
        d="M42.5 4.5 27 14M45.5 7.5 31 18.5M42.5 4.5a2.3 2.3 0 0 1 3 3M27 14l-1.8 1.6M31 18.5l-1.2 2"
        stroke="var(--ink)"
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The AI's flame from the mark, which starts each AI reply. */
export function Flame({ size = 24, className }: IconProps & { className?: string }) {
  return (
    <svg width={size} height={size} viewBox="14 12 20 20" aria-hidden className={className}>
      <path
        d="M24 30c-4.2 0-7-2.9-7-6.4 0-3.9 3.3-5.6 4.2-9.6 2.6 2 3.7 4 3.7 6 1.3-.8 2.1-2.1 2.4-3.6 2.3 1.9 3.7 4.3 3.7 7.2 0 3.6-3 6.4-7 6.4Z"
        fill="var(--ember)"
      />
      <path
        d="M24 30c-2.1 0-3.4-1.4-3.4-3.1 0-1.9 1.6-2.8 2.1-4.7 1.3 1 1.8 2 1.8 3 .7-.4 1-1 1.2-1.8 1.1.9 1.8 2.1 1.8 3.5 0 1.8-1.5 3.1-3.5 3.1Z"
        fill="var(--saffron)"
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

/** Opens a menu below or above, like the composer's model menu. */
export function ChevronDownIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="m3 4.5 3 3 3-3" {...stroke} strokeWidth={1.5} />
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

/** Send a message: an arrow up. */
export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" {...stroke} strokeWidth={1.7} />
    </svg>
  );
}

/** Think deeper (ticket 0081): a light bulb. */
export function BulbIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.2v.6h4v-.6c0-.5.2-.9.6-1.2A4.5 4.5 0 0 0 8 1.5Z"
        {...stroke}
        strokeWidth={1.4}
      />
    </svg>
  );
}

/** Stop the reply being written. */
export function StopIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <rect x="2" y="2" width="10" height="10" rx="2.5" fill="currentColor" />
    </svg>
  );
}

/** A document: the Spec or the Project Brief. */
export function DocIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 1.8h5.2L12.5 5v9.2H4V1.8Z" {...stroke} strokeWidth={1.3} />
      <path d="M9 1.8V5h3.5M6 8.2h4.5M6 10.8h4.5" {...stroke} strokeWidth={1.3} />
    </svg>
  );
}

/** Opens a full page. */
export function ExternalIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"
        {...stroke}
        strokeWidth={1.3}
      />
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

export function ForwardIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m6 3 5 5-5 5" {...stroke} strokeWidth={1.7} />
    </svg>
  );
}

/** The ticked item of a list or a checkbox. */
export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" {...stroke} strokeWidth={1.9} />
    </svg>
  );
}

/** Opens a date picker's calendar. */
export function CalendarIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="11" rx="2.5" {...stroke} strokeWidth={1.3} />
      <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" {...stroke} strokeWidth={1.3} />
    </svg>
  );
}

/** A searchable list. */
export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" {...stroke} strokeWidth={1.4} />
      <path d="m10.5 10.5 3 3" {...stroke} strokeWidth={1.5} />
    </svg>
  );
}

/** A time zone. */
export function GlobeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" {...stroke} strokeWidth={1.3} />
      <path
        d="M2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2Z"
        {...stroke}
        strokeWidth={1.3}
      />
    </svg>
  );
}
