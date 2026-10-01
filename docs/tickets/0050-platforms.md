---
status: todo
depends-on: []
slice: platforms
---

# 0050: Platforms per Project, targeted by Features

## Goal
Each Project has its own list of Platforms, and each Feature says which of them it targets (ADR 0009).

## Scope
- Prisma:
  - `Platform` has a Project, a name, a position, its Team Roles, and its checks: `specSection`, `someoneToAsk` and `noOpenBlockers`, each a boolean.
  - `FeaturePlatform` links a Feature to the Platforms it targets.
  - `OrgPlatformTemplate` is the Organization's default list.
- Built-in templates:
  - **Back-End**: BACKEND.
  - **Front-End**: FRONTEND.
  - **Mobile**: MOBILE.
  - An Admin can add more, for example **Flutter**: MOBILE.
  - Every check is on by default.
- When a Project is created, its Platforms are copied from the Organization default. Later changes to the default don't rewrite existing Projects.
- API:
  - `GET` and `PUT /projects/:id/platforms`: the Project's POs and Admins edit; everyone reads.
  - `GET` and `PUT /settings/platform-template`: Admins edit; every member reads.
  - `PUT /features/:id/platforms` sets a Feature's target Platforms.
- A new Feature's Spec template gets one `## <Platform>` section per target Platform.

## Acceptance criteria (test first, real Postgres)
- [ ] A new Project gets the Organization default. Adding Flutter to one Project leaves the others unchanged.
- [ ] A Feature can only target its own Project's Platforms. Removing a Platform that Features target is refused, and the response names those Features.
- [ ] The Spec template for a Feature targeting Back-End and Flutter has both sections.
