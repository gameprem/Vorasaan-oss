'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { SidebarData } from '@/lib/sidebar';
import {
  CaretIcon,
  CloseIcon,
  GearIcon,
  InboxIcon,
  MenuIcon,
  PanelIcon,
  PlusIcon,
  SentIcon,
  Spark,
} from './icons';

// The app shell (ADR 0008): a tinted rail Sidebar on the left and the stage in the middle.
// On a desktop the Sidebar collapses to a rail of icons (remembered in a cookie, so the
// server renders it the same way); on a phone it is a drawer behind the menu button.

export const SIDEBAR_COOKIE = 'vorasaan-sidebar';
export const NEW_CONVERSATION_HREF = '/conversations/new';
/** The Settings modal sends focus back here when it closes. */
export const SETTINGS_BUTTON_ID = 'settings-button';

type Me = { name: string; isAdmin: boolean };

export function Shell({
  me,
  data,
  initiallyCollapsed,
  footer,
  children,
}: {
  me: Me;
  data: SidebarData;
  initiallyCollapsed: boolean;
  /** Under the user: the dev user switcher or Sign out, and the live-updates status. */
  footer: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    // biome-ignore lint/suspicious/noDocumentCookie: a plain UI preference; the server reads it
    document.cookie = `${SIDEBAR_COOKIE}=${next ? 'collapsed' : 'open'}; path=/; max-age=31536000; samesite=lax`;
  };

  // Focus returns to the menu button once the stage is no longer inert.
  const refocusMenu = useRef(false);
  const closeDrawer = useCallback((focusMenu: boolean) => {
    refocusMenu.current = focusMenu;
    setDrawerOpen(false);
  }, []);

  // Moving to another page closes the drawer.
  const [shownPath, setShownPath] = useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    setDrawerOpen(false);
  }

  // Opening the drawer moves focus into it; closing it, back to the menu button.
  useEffect(() => {
    if (drawerOpen) {
      sidebar.current?.querySelector<HTMLElement>('.drawer-close')?.focus();
    } else if (refocusMenu.current) {
      refocusMenu.current = false;
      menuButton.current?.focus();
    }
  }, [drawerOpen]);

  // Ctrl+K (⌘K on a Mac) starts a new Conversation from anywhere, except inside the
  // Spec editor, where it adds a link.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawerOpen) {
        closeDrawer(true);
        return;
      }
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) {
        return;
      }
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      router.push(NEW_CONVERSATION_HREF);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router, drawerOpen, closeDrawer]);

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to the main area
      </a>
      <div className="app" data-collapsed={collapsed}>
        <aside
          ref={sidebar}
          id="sidebar"
          className="side"
          aria-label="Sidebar"
          data-open={drawerOpen}
        >
          <Sidebar
            me={me}
            data={data}
            pathname={pathname}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onCloseDrawer={() => closeDrawer(true)}
            footer={footer}
          />
        </aside>
        <div
          className="scrim"
          data-open={drawerOpen}
          aria-hidden
          onClick={() => closeDrawer(true)}
        />
        <div className="stage" inert={drawerOpen}>
          <header className="top-bar">
            <button
              ref={menuButton}
              type="button"
              className="icon-btn"
              aria-label="Open the Sidebar"
              aria-controls="sidebar"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon />
            </button>
            <Spark size={22} />
            <b>Vorasaan</b>
          </header>
          <main id="main" tabIndex={-1}>
            <div className="mx-auto w-full max-w-5xl">{children}</div>
          </main>
        </div>
      </div>
    </>
  );
}

/** "⌘K" on a Mac, "Ctrl K" elsewhere; known only in the browser. */
function useShortcutLabel() {
  const [label, setLabel] = useState('Ctrl K');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setLabel('⌘K');
  }, []);
  return label;
}

function Sidebar({
  me,
  data,
  pathname,
  collapsed,
  onToggleCollapsed,
  onCloseDrawer,
  footer,
}: {
  me: Me;
  data: SidebarData;
  pathname: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCloseDrawer: () => void;
  footer: ReactNode;
}) {
  const shortcut = useShortcutLabel();
  const current = (href: string, exact = false) =>
    (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`))
      ? ('page' as const)
      : undefined;

  const waiting = data.inboxItems + data.unreadNotifications;
  const waitingText = [
    data.inboxItems > 0 && `${data.inboxItems} to act on`,
    data.unreadNotifications > 0 &&
      `${data.unreadNotifications} unread Notification${data.unreadNotifications === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <>
      <div className="brand">
        <Spark size={24} className="spark-mark" />
        <b className="brand-name">Vorasaan</b>
        <span className="th brand-name" lang="th">
          วรสาร
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="icon-btn collapse-toggle"
          aria-label={collapsed ? 'Expand the Sidebar' : 'Collapse the Sidebar'}
          aria-controls="sidebar"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand the Sidebar' : 'Collapse the Sidebar'}
          onClick={onToggleCollapsed}
        >
          <PanelIcon />
        </button>
        <button
          type="button"
          className="icon-btn drawer-close"
          aria-label="Close the Sidebar"
          onClick={onCloseDrawer}
        >
          <CloseIcon />
        </button>
      </div>

      <Link
        href={NEW_CONVERSATION_HREF}
        className="new"
        aria-current={current(NEW_CONVERSATION_HREF, true)}
        aria-keyshortcuts="Control+K Meta+K"
        title={collapsed ? `New conversation (${shortcut})` : undefined}
      >
        <PlusIcon />
        <span className="new-text">New conversation</span>
        <kbd aria-hidden>{shortcut}</kbd>
      </Link>

      <nav className="side-scroll" aria-label="Main">
        <div className="group">
          <Link
            href="/inbox"
            className="item"
            aria-current={current('/inbox')}
            title={collapsed ? 'Inbox' : undefined}
          >
            <InboxIcon />
            <span className="label">Inbox</span>
            {waiting > 0 && (
              <>
                <span className="count" aria-hidden title={waitingText}>
                  {waiting > 99 ? '99+' : waiting}
                </span>
                <span className="sr-only">, {waitingText}</span>
              </>
            )}
          </Link>
          <Link
            href="/requests"
            className="item"
            aria-current={current('/requests')}
            title={collapsed ? 'My Requests' : undefined}
          >
            <SentIcon />
            <span className="label">My Requests</span>
          </Link>
        </div>

        <Projects projects={data.projects} pathname={pathname} current={current} />

        <div className="group collapsible">
          <h2>Recent conversations</h2>
          {data.recent.length === 0 ? (
            <p className="side-empty">No Conversations yet.</p>
          ) : (
            data.recent.map((c) => (
              <Link
                key={c.id}
                href={`/conversations/${c.id}`}
                className="item"
                aria-current={current(`/conversations/${c.id}`)}
              >
                <span className="label">{c.title}</span>
                <span className="muted">{c.scope}</span>
              </Link>
            ))
          )}
        </div>
      </nav>

      <div className="side-foot">
        <Link
          id={SETTINGS_BUTTON_ID}
          href="/settings/members"
          className="item"
          title={collapsed ? 'Settings' : undefined}
        >
          <GearIcon />
          <span className="label">Settings</span>
        </Link>
        <div className="me">
          <span className="avatar" aria-hidden>
            {me.name.trim().charAt(0).toUpperCase() || '?'}
          </span>
          <div className="me-text min-w-0">
            <span className="block truncate">{me.name}</span>
            <small>{me.isAdmin ? 'Admin' : 'Member'}</small>
          </div>
        </div>
        {footer}
      </div>
    </>
  );
}

function Projects({
  projects,
  pathname,
  current,
}: {
  projects: SidebarData['projects'];
  pathname: string;
  current: (href: string) => 'page' | undefined;
}) {
  // The Project you are in starts expanded; the rest stay as you left them.
  const activeProject = projects.find(
    (p) =>
      pathname.startsWith(`/projects/${p.id}`) ||
      p.features.some((f) => pathname.startsWith(`/features/${f.id}`)),
  )?.id;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(activeProject ? [activeProject] : []),
  );
  const [seenActive, setSeenActive] = useState(activeProject);
  if (activeProject !== seenActive) {
    setSeenActive(activeProject);
    if (activeProject && !expanded.has(activeProject)) {
      setExpanded(new Set([...expanded, activeProject]));
    }
  }
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="group collapsible">
      <h2>
        <Link href="/projects">Projects</Link>
      </h2>
      {projects.length === 0 ? (
        <p className="side-empty">No Projects yet.</p>
      ) : (
        projects.map((p) => {
          const open = expanded.has(p.id);
          const listId = `sidebar-project-${p.id}`;
          return (
            <div key={p.id} className="grid min-w-0 gap-0.5">
              <div className="project-row">
                <button
                  type="button"
                  className="caret"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-label={`${open ? 'Hide' : 'Show'} the Features of ${p.name}`}
                  onClick={() => toggle(p.id)}
                >
                  <CaretIcon />
                </button>
                <Link
                  href={`/projects/${p.id}`}
                  className="item"
                  aria-current={current(`/projects/${p.id}`)}
                >
                  <span className="label">{p.name}</span>
                </Link>
              </div>
              <div className="features" id={listId} hidden={!open}>
                {p.features.length === 0 ? (
                  <p className="side-empty">No Features yet.</p>
                ) : (
                  p.features.map((f) => (
                    <Link
                      key={f.id}
                      href={`/features/${f.id}`}
                      className="item"
                      aria-current={current(`/features/${f.id}`)}
                    >
                      <span className={`dot${f.openBlockers > 0 ? ' blocker' : ''}`} aria-hidden />
                      <span className="label">{f.title}</span>
                      {f.openBlockers > 0 && (
                        <span className="muted">
                          {f.openBlockers} Blocker{f.openBlockers === 1 ? '' : 's'}
                        </span>
                      )}
                    </Link>
                  ))
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
