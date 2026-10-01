---
status: todo
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
- [ ] Every current page is reachable from the Sidebar. No page needs the old top navigation.
- [ ] The Inbox count updates when a Decision Request arrives, without a reload.
- [ ] Settings opens as a full-screen modal. Back and Esc return to the same Conversation, and its scroll position and composer draft are kept. A `/settings/ai` link or reload opens the modal on AI provider.
- [ ] The shell matches the mockup in light and dark themes, checked with screenshots side by side.
- [ ] At 375px wide the Sidebar is a drawer, and the page doesn't scroll sideways.
