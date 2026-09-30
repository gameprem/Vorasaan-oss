---
status: todo
depends-on: [0001]
slice: tracer-bullet
---

# 0002: Seed data for the tracer bullet

## Goal
One command that gives a developer a usable world: an Organization with a Feature that has a Spec, a PO and a Backend dev.

## Scope
- `packages/db/prisma/seed.ts`, run with `bun run db:seed`. It must be idempotent: running it twice doesn't duplicate data, because it upserts on stable keys.
- Create:
  - Organization "Acme"
  - Project "Mobile Banking" (`jiraKey: MB`)
  - Team "Checkout"
  - Users: **Pim** (PO) and **Beam** (Backend), each with an `OrgMembership` (MEMBER) and a `TeamMembership` with their Team Role
  - Feature "Async checkout" with Role Owners Pim (PO) and Beam (BACKEND)
  - **Spec Version 1**: a realistic ~40-line Markdown Spec (goal, user flow, acceptance criteria), `source: MANUAL`, approved by Pim
- At the end, print the user ids and the Feature id so they can be used as `x-vorasaan-user` and in the CLI.

## Acceptance criteria
- [ ] `bun run db:seed` on an empty database creates exactly the data above.
- [ ] Running it a second time changes nothing and doesn't fail.
- [ ] The seed is reusable from tests: export a function that seeds into a given client.

## Notes
- Use stable, readable ids or unique emails (`pim@acme.test`) as upsert keys.
