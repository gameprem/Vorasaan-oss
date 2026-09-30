---
status: todo
depends-on: [0019]
slice: mvp-cli
---

# 0028: CLI: `vorasaan` TUI and `vorasaan init`

## Goal
Running `vorasaan` opens a long-lived Ink TUI with the Inbox, My Requests and Features tabs (REQUIREMENT §3.6).

## Scope
- `vorasaan init`: pick a Project and write `.vorasaan/config.json`; the Feature list is then scoped to it and bound Features are highlighted.
- Tabs:
  - **Inbox**: Inbox Items, then Notifications;
  - **My Requests**;
  - **Features**: those where I'm a Role Owner, with the latest Spec readable.
- `r` raises a Decision Request from any tab, with context from the current repo (current diff, chosen files, text), reusing the `raise` command's logic.
- Keyboard navigation and help line; `q` quits.
- Scriptable subcommands keep working.

## Acceptance criteria
- [ ] Component tests with `ink-testing-library` for tab switching, lists and the raise form.
- [ ] Manually verified against a running server.
