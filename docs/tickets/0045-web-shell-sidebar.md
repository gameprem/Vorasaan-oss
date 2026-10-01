---
status: done
depends-on: [0042]
slice: chat-web-ui
---

# 0045: Web: app shell with the Sidebar

## Goal
The web app looks and moves like a chat app (Claude or Gemini): a Sidebar on the left and the work in the middle.

## Scope
- **Sidebar, from top to bottom:**
  - New conversation.
  - Inbox, with its unread count, live over SSE.
  - Projects, each expanding to its Features. Selecting one opens its latest Conversation, or a new one.
  - Recent Conversations.
  - Settings at the bottom. It opens Settings as a full-screen modal over the app.
- **Settings modal:**
  - It covers the whole screen.
  - The top-left has a **Back** button, which returns to the exact Conversation or page you came from. Esc does the same.
  - Inside, a section list (Members, Delegations, Feature Guidelines, AI provider, Access tokens) sits beside the selected section's content.
  - Each section has its own URL (`/settings/...`), so a link or a reload opens the modal on that section. Opening it from the app overlays the current page (Next.js intercepting and parallel routes); opening the URL directly shows it over the default view.
  - Focus is trapped inside while it is open and goes back to the Settings button when it closes.
- The Sidebar collapses. On a phone it becomes a drawer. The existing pages render inside the shell.
- Keyboard: a shortcut opens a new Conversation, and the focus order goes through the Sidebar and then the main area.
- Visual design per ADR 0008 and the mockup in `docs/design/chat-web-ui-mockup.html`:
  - Move its colour, type and radius tokens into `apps/web/app/globals.css`, replacing the MVP palette, with both themes.
  - The Sidebar is a tinted rail with no border, and its items are pills.
- Read the Next.js 16 docs in `node_modules/next/dist/docs/` first (layouts, parallel routes).

## Acceptance criteria
- [x] Every current page is reachable from the Sidebar. No page needs the old top navigation.
- [x] The Inbox count updates when a Decision Request arrives, without a reload.
- [x] Settings opens as a full-screen modal. Back and Esc return to the same Conversation, and its scroll position and composer draft are kept. A `/settings/ai` link or reload opens the modal on AI provider.
- [x] The shell matches the mockup in light and dark themes, checked with screenshots side by side.
- [x] At 375px wide the Sidebar is a drawer, and the page doesn't scroll sideways.

## Decisions
- **Tokens:** the mockup's `:root` block moved into `globals.css` under its own names (`--bg`, `--rail`, `--ink`, `--r-m` ...), light and dark (system preference, or `data-theme` on `<html>`). `@theme inline` maps them to utilities (`bg-rail`, `text-fg-soft`, `bg-ink text-on-ink`, `rounded-card`, `shadow-card`). The MVP palette is gone: its `ink` was the text colour, now `fg`; `seal` is now `lacquer`. Text on any solid accent (ink, jade, lacquer) uses `on-ink`, which keeps dark-mode contrast where the mockup's white on jade wouldn't.
- **Fonts:** Figtree, Anuphan and JetBrains Mono through `next/font/google`, replacing IBM Plex.
- **Restyle:** lists are `.rows` (tonal tiles on a rail, as in the mockup's Settings rows), cards are `rounded-card bg-rail`, tabs are pill chips, buttons are pills. Form fields keep a 1px inset ring in `--line` on a `surface` fill: without it a field inside a rail card is almost invisible.
- **Sidebar items:** Inbox's count is its Inbox Items plus unread Notifications (both are on the Inbox page, and the old header showed the unread count). It updates live because the existing `LiveUpdates` refreshes the route on `inbox.changed` and `notification.created`, which re-renders the layout. "My Requests" sits under Inbox, so the old nav's page stays reachable. The "Projects" heading links to the Projects list.
- **Projects and Features open their pages, not a Conversation.** The chat view is ticket 0046; until then a Project or Feature in the Sidebar opens its existing page. A caret expands a Project; the Project you are in starts expanded. Features come from `GET /teams/:id` per Team (the same calls the Project page makes), with a lacquer dot for open Blockers.
- **Conversations:** New conversation (Ctrl+K, ⌘K on a Mac, ignored inside the Spec editor where it adds a link) opens `/conversations/new`, a greeting placeholder. Recent conversations (`GET /conversations?recent`) show title and scope (the Feature, or the Project) and open `/conversations/[id]`, a placeholder naming the Conversation and its scope. Ticket 0046 replaces both.
- **Collapse:** on a desktop the Sidebar collapses to a 76px rail of icons (labels stay for screen readers), remembered in the `vorasaan-sidebar` cookie so the server renders it the same way. At 760px and below it is a drawer behind a menu button, with a scrim; Esc, the scrim or picking a page closes it, and focus returns to the menu button. The page behind is `inert` while it is open.
- **Settings routes:** `app/settings/*` are the real pages, wrapped by `app/settings/layout.tsx` in the modal (`mode="page"`). `app/@modal/(.)settings/*` re-export the same pages, wrapped in the modal with `mode="overlay"`, so opening Settings from the app intercepts into the `@modal` slot and the page underneath stays mounted (its scroll position and any draft). `@modal/default.tsx`, `page.tsx` and `[...catchAll]` render nothing, so a link inside Settings closes it; `app/default.tsx` sends an unknown URL to the not-found page.
- **Back:** over a page, Back and Esc are `router.back()`, and section links `replace` the URL, so one Back leaves Settings. Opened by a link or reload there is no page underneath, so Back goes to the Inbox, and the section links are plain links: a soft navigation from there would be intercepted into a second modal.
- **Members moved into Settings** at `/settings/members`; `/members` redirects there. The section list says "AI models", the name 0053 gave the page, rather than "AI provider".
- **Focus:** the modal focuses Back, makes everything outside it `inert`, wraps Tab inside it, and on close focuses the Settings button.
- **Signed out** (login, setup, invitation): no Sidebar. The dev user switcher shows at the top right there, and at the bottom of the Sidebar, under the user, when signed in.

