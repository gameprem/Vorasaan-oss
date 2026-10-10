---
status: done
depends-on: []
slice: platforms
---

# 0050: Platforms per Project, targeted by Features

## Goal
Each Project has its own list of Platforms, and each Feature says which of them it targets (ADR 0009).

## Scope
- Prisma:
  - `Platform` has a Project, a name, a position, its Team Roles, and its checks: `specSection`, `someoneToAsk`, `noOpenBlockers` and `qaReady`, each a boolean.
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
- A new Feature's Spec template gets one `## <Platform>` section per target Platform, each with an empty `### Acceptance criteria` subsection.

## Acceptance criteria (test first, real Postgres)
- [x] A new Project gets the Organization default. Adding Flutter to one Project leaves the others unchanged.
- [x] A Feature can only target its own Project's Platforms. Removing a Platform that Features target is refused, and the response names those Features.
- [x] The Spec template for a Feature targeting Back-End and Flutter has both sections.

## Decisions
- **Data** (`packages/db`, migration `platforms`):
  - `Platform` (`projectId`, `name`, `position`, `roles TeamRole[]`, and the four checks `specSection`, `someoneToAsk`, `noOpenBlockers`, `qaReady`, all default true). Names are unique per Project **ignoring case** (a unique index on `lower(name)` in the migration, which Prisma leaves alone), because a Spec section matches its `##` heading case-insensitively (0051); the Zod contract refuses duplicates first (400).
  - `FeaturePlatform` (`featureId`, `platformId`), both cascading. The ticket's "removing a targeted Platform is refused" is enforced by the service, not by a NO ACTION key: Postgres checks such a key in the middle of a Project's cascade (Project → Platform before Project → Team → Feature → FeaturePlatform) and refused deleting a whole Project. The service locks the Project's row `FOR UPDATE` while replacing its list, and targeting takes it `FOR SHARE`, so a Platform can't be removed while a Feature is being pointed at it.
  - `OrgPlatformTemplate` (`organizationId`, `name`, `position`, `roles`, the four checks): the Organization's default. **No rows means the built-in template** (`BUILT_IN_PLATFORMS` in `@vorasaan/shared`: Back-End → BACKEND, Front-End → FRONTEND, Mobile → MOBILE, every check on). So first-run setup, the seed and the many tests that create an Organization directly need no change, and the default can't be saved empty (at least one Platform).
  - **Existing data**: the migration gives every existing Project the built-in template (positions 0-2, every check on), as if it had been created now. Existing Features target nothing: nothing recorded which Platforms they ship on, and guessing would make 0051's Coverage report gaps nobody chose.
  - The seed gives the seeded Project the built-in Platforms with fixed ids (`SEED.platforms.backEnd`, `frontEnd`, `mobile`), as a Project created in the app would get; the seeded Feature targets none.
- **API** (`PlatformsModule`, contracts in `@vorasaan/shared` `platform.ts`):
  - `GET /settings/platform-template` (every member; `PlatformTemplateView` with `builtIn: true` until an Admin saves one) and `PUT /settings/platform-template` (Admins; `PlatformTemplateInput`, the whole ordered list, 1-20). It never rewrites existing Projects.
  - `GET /projects/:id/platforms` (everyone in the Organization; `ProjectPlatformsView` with `canEdit`) and `PUT /projects/:id/platforms` (Admins and the POs of the Project's Teams, the same rule as the Project Brief and Feature Guidelines: "the Project's POs" reconciled with 0012's Teams). The list is replaced whole: a Platform sent with its `id` is updated in place (rename, reorder, roles, checks), so the Features targeting it keep it; one without is added; one left out is removed. Removing Platforms that Features target is a **409 `PlatformsInUse`** whose message and `features` (`id`, `title`, `platformId`, `platformName`) name every such Feature, and nothing changes. Renames go through a temporary name, so swapping two names works under the unique index. An id of another Project is a 422.
  - `PUT /features/:id/platforms` (`SetFeaturePlatformsInput { platformIds }`; Admins and the Team's PO, as for Role Owners) returns the targets in the Project's order. A Platform of another Project is a 422 and nothing changes. `POST /teams/:id/features` also takes optional `platformIds`, with the same check in the same transaction (none when left out).
  - `GET /features/:id` (`FeatureView`) gains `platforms` (`PlatformRef { id, name }`, in the Project's order), for the Feature header chips of 0052. It is one query run alongside the Feature's own; through an include Prisma would send two. The `feature` query budget goes from 5 to 6 and the Feature page's from 31 to 32 (`perf/scenarios.ts`), on purpose.
  - `GET /features/:id/spec-template` (`SpecTemplateView { markdown }`): the template a first Spec starts from. The ticket's "Spec template" lived only in the web editor (`SPEC_TEMPLATE`); it moved to `@vorasaan/shared` as `specTemplate({ title, platforms })`, used by the server and by the editor's default. It now starts with the Feature's title, and has one `## <Platform>` section per target Platform, in the Project's order, each with an empty `### Acceptance criteria` subsection, between the general Acceptance criteria and Out of scope. Nothing is written until a person saves the first Spec Version, so the template follows the targets until then.
- **Glossary**: CONTEXT.md gains **Platform template** (the `OrgPlatformTemplate` list, built-in until an Admin changes it), and the Platform entry says it is copied from it and names its Team Roles and checks.
- **Platform names** are one line of at most 40 characters without `#`, since each becomes a `##` heading.
- **Web (minimal; the full UI is 0052)**: the Feature header lists its target Platforms; on the Spec tab, people who write the Spec tick the Project's Platforms the Feature targets (`FeaturePlatformsEditor`, the kit's chip checkboxes) and a first Spec opens from the server's template. Editing a Project's list and the Organization default in the web app, and Coverage chips, stay in 0052.
- **Not here**: the AI doesn't read Platforms yet; filling missing sections, Grilling about Platforms and Coverage are 0051. 0069's Design Doc templates per Platform will hang off `Platform` (a Platform added later "names the template it starts from"), which this model leaves room for.
- **Tests** (`platforms/platforms.api.test.ts`, real Postgres): the built-in default and who reads and replaces it; a new Project copies the default and later changes don't rewrite it; adding Flutter to one Project leaves the others; who edits a Project's list; editing in place keeps ids and targets (rename, reorder, swapped names, a check off); a Feature only targets its own Project's Platforms, also at creation; removing targeted Platforms is refused naming the Features, then allowed once untargeted, and deleting the Project still cascades; the Spec template for Back-End and Flutter has both sections. The migration's copy into existing Projects was checked by hand on a database with a Project created before it. In the browser, `e2e/platforms.e2e.ts`: a PO ticks Back-End and Mobile on a new Feature, the header lists them and the first Spec opens with both sections (axe on the picker and the list; BlockNote's own editor markup has unlabelled controls, as before).
