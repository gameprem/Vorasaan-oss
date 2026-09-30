---
status: done
depends-on: [0006]
slice: tracer-bullet
---

# 0008: Web: decide and approve

## Goal
The PO opens a web page, sees the open Decision Request, picks a Choice, reviews the Spec diff, and approves it. This closes the tracer bullet.

## Scope
- Turn `apps/web` into a Next.js 16 (App Router) workspace package, with Tailwind and shadcn/ui, running on Bun. *(Built with Tailwind and hand-written components; shadcn/ui was not added. See the PR.)*
- **Dev user switcher:** a simple dropdown of seeded users stored in a cookie and sent as `x-vorasaan-user`. It is clearly marked dev-only.
- **Inbox page** (`/inbox`): the Decision Requests where I'm the Decider and the status is `OPEN`, with the Feature, kind (a Blocker badge) and Raiser.
- **Decision Request page:**
  - **Choice Widget:** one card per Choice showing title, description and impact on scope/time/risk. Selecting one opens a confirmation, with an optional rationale.
  - An "Answer in my own words" option (free text).
  - After deciding, show the Spec Proposal as a **side-by-side or unified Markdown diff**, with Approve and Reject buttons.
- **Feature page:** the latest Spec rendered as Markdown, a Version History list (version, source, approver, date), and a Decision Log tab.

## Acceptance criteria
- [x] Manual end-to-end: after seeding, Beam raises via the CLI (0007), Pim decides and approves on the web, and the Feature page shows Spec v2 with the Decision linked.
- [x] Types come from `@vorasaan/shared`; there are no hand-written duplicates of API shapes.
- [x] Loading, empty and error states exist for every page, and there are no unhandled promise rejections.
- [ ] Screenshots of the flow are attached to the PR. **Not done: the flow was verified in a browser, but screenshots could not be uploaded from the CLI.**

## Notes
- The BlockNote editor isn't needed yet; rendering Markdown read-only is enough for the tracer.
