---
status: todo
depends-on: [0045, 0046]
slice: ui-kit
---

# 0077: UI kit, and replace browser-native controls

## Goal
Every form in the web app uses our own accessible, themed controls instead of browser-native ones, with searchable pickers and Thai-aware dates (ADR 0016).

## Scope
- **The kit**, in `apps/web/components/ui/`, on `react-aria-components`, styled with the ADR 0008 tokens in light and dark:
  - **Select** and a searchable **ComboBox**, with an optional icon and description per item. Used for the model, Team Role, person and Feature pickers.
  - **Person picker:** a ComboBox showing each person's avatar and Team Roles.
  - **Time-zone combobox:** searchable by city or zone in English and Thai ("Bangkok" and "กรุงเทพ" both find `Asia/Bangkok`), showing the current offset.
  - **Date and time picker**, with an optional Buddhist-era display (2569 for 2026) that follows the person's language. Used by Delegation periods, public holidays, Quiet Hours, Working Time and the Decision Lead Time range.
  - Checkbox, Radio group, Switch, Segmented control, Menu, Popover, Tooltip, Toast, Tabs, Dialog, Skeleton and Empty state.
- **Gallery:** a dev-only page at `/dev/ui` showing every component in every state, in both themes. It is not served in production.
- **Replace native controls app-wide:** every native `<select>` (about 22 today, in about 15 files) and every native checkbox, radio, date and time input (about 22). Behaviour stays the same; only the control changes.
- **Existing look:** pills, tone-separated surfaces, no hard borders (ADR 0008).

## Acceptance criteria (test first)
- [ ] A test greps `apps/web` (outside `components/ui/`) and fails on a native `<select>`, or an `<input>` of type date, time, datetime-local, checkbox or radio.
- [ ] Unit tests: the time-zone combobox finds `Asia/Bangkok` from "Bangkok" and "กรุงเทพ"; the date picker shows a Buddhist-era year when asked and stores the same ISO date either way.
- [ ] e2e on `/dev/ui` and the key forms (Delegation, Settings → AI models, Settings → Working Time, raise a Decision Request): every control works with the keyboard alone, and axe reports no violations, in light and dark.
- [ ] A screen reader announces a ComboBox's options and the selected date (checked with axe and the accessibility tree in e2e).
- [ ] All existing e2e tests still pass.
