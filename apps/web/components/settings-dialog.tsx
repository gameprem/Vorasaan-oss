'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { BackIcon } from './icons';
import { SETTINGS_BUTTON_ID } from './shell';

// Settings as a full-screen modal over the app (ADR 0008). Each section has its own
// /settings/... URL:
// - "overlay": opened from the app, the route is intercepted (app/@modal/(.)settings) and the
//   page you came from stays mounted underneath, scroll position and drafts included.
//   Back and Esc go back in history, to that exact page.
// - "page": a link or a reload renders app/settings directly. There is no page underneath,
//   so Back and Esc go to the Inbox, the default view.

export const SETTINGS_SECTIONS = [
  { href: '/settings/organization', label: 'Organization' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/delegations', label: 'Delegations' },
  { href: '/settings/notifications', label: 'Notifications' },
  { href: '/settings/feature-guidelines', label: 'Feature Guidelines' },
  { href: '/settings/response-windows', label: 'Response Windows' },
  { href: '/settings/chat-apps', label: 'Chat apps' },
  { href: '/settings/ai', label: 'AI models' },
  { href: '/settings/ai/prompts', label: 'AI prompts' },
  { href: '/settings/tokens', label: 'Access tokens' },
] as const;

const DEFAULT_VIEW = '/inbox';

/** The section a path belongs to: the longest href it starts with (AI prompts within AI). */
export function currentSection(pathname: string): string | undefined {
  return SETTINGS_SECTIONS.map((s) => s.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}

const SettingsMode = createContext<'overlay' | 'page'>('page');

/**
 * A link from one Settings page to another, such as a prompt in AI prompts. Over the app
 * ("overlay") it is a soft navigation the modal route intercepts, so Back still returns
 * to the page underneath; on its own ("page") a full load, as the nav does.
 */
export function SettingsLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const mode = useContext(SettingsMode);
  return mode === 'overlay' ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
/** Never made inert: Next announces route changes from here. */
const KEEP_LIVE = new Set(['NEXT-ROUTE-ANNOUNCER', 'SCRIPT', 'STYLE', 'TEMPLATE']);
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Makes everything outside `node` inert; returns the undo. */
function inertOutside(node: HTMLElement) {
  const changed: HTMLElement[] = [];
  for (let el: HTMLElement | null = node; el && el !== document.body; el = el.parentElement) {
    for (const sibling of el.parentElement?.children ?? []) {
      if (
        sibling !== el &&
        sibling instanceof HTMLElement &&
        !sibling.inert &&
        !KEEP_LIVE.has(sibling.tagName)
      ) {
        sibling.inert = true;
        changed.push(sibling);
      }
    }
  }
  return () => {
    for (const el of changed) el.inert = false;
  };
}

export function SettingsDialog({
  mode,
  children,
}: {
  mode: 'overlay' | 'page';
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const dialog = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);

  const close = () => {
    if (mode === 'overlay') router.back();
    else router.push(DEFAULT_VIEW);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    back.current?.focus();
    const undoInert = inertOutside(node);
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // Keep focus inside: wrap from the last control to the first and back.
      const all = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const first = all[0];
      const last = all.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      undoInert();
      root.style.overflow = overflow;
      // Back to the button that opened Settings, once the modal is gone.
      requestAnimationFrame(() => document.getElementById(SETTINGS_BUTTON_ID)?.focus());
    };
  }, []);

  return (
    <div
      ref={dialog}
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div className="settings-top">
        <button ref={back} type="button" className="back" onClick={close}>
          <BackIcon />
          Back
        </button>
        <h1 id="settings-title">Settings</h1>
      </div>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => {
            const current = currentSection(pathname) === s.href ? ('page' as const) : undefined;
            // Overlay: replace, so Back leaves Settings in one step. Page: a full load,
            // because a soft navigation would be intercepted into a second modal.
            return mode === 'overlay' ? (
              <Link key={s.href} href={s.href} replace className="item" aria-current={current}>
                <span className="label">{s.label}</span>
              </Link>
            ) : (
              <a key={s.href} href={s.href} className="item" aria-current={current}>
                <span className="label">{s.label}</span>
              </a>
            );
          })}
        </nav>
        <section className="settings-pane">
          <SettingsMode.Provider value={mode}>{children}</SettingsMode.Provider>
        </section>
      </div>
    </div>
  );
}
