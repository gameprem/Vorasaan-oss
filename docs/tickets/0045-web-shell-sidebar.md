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
  - Settings at the bottom: Members, Delegations, Feature Guidelines, AI provider, Access tokens.
- The Sidebar collapses. On a phone it becomes a drawer. The existing pages render inside the shell.
- Keyboard: a shortcut opens a new Conversation, and the focus order goes through the Sidebar and then the main area.
- Read the Next.js 16 docs in `node_modules/next/dist/docs/` first (layouts, parallel routes).

## Acceptance criteria
- [ ] Every current page is reachable from the Sidebar. No page needs the old top navigation.
- [ ] The Inbox count updates when a Decision Request arrives, without a reload.
- [ ] At 375px wide the Sidebar is a drawer, and the page doesn't scroll sideways.
