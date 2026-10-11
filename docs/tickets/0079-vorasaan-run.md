---
status: in-progress
depends-on: [0052, 0060, 0068, 0069, 0076]
slice: vorasaan-run
---

# 0079: `vorasaan run`: hand a Feature's context to the coding assistant

## Goal
A developer runs `vorasaan run --ai claude` in their repository, and their coding assistant reads one Feature's approved context (the latest Spec, its Decisions, the Project rules, the most relevant retrieved context, the Jira Epic key and the approved Design Doc of their Platform) from one file, instead of everything or a guess (REQUIREMENT 15, ADR 0002, ADR 0014).

## Scope
- **`vorasaan run [--feature <id or title>] [--ai claude|codex|gemini] [--platform <name|qa|none>] [--budget <tokens>] [--no-launch]`** writes the Feature's **Hand-off** (new glossary term) to `.vorasaan/specs/<feature>.md` at the repository root, then hands it to the coding assistant: started in the repository when it is on PATH and a person is at the terminal, else the command to start it is printed.
  - **The Feature:** `--feature` takes an id, or the title or file name of a Feature the user is a Role Owner of (the bound Project's first, as `vorasaan init` scopes them); without it, the only Feature in scope, or a picker.
  - **The Platform** whose approved Design Doc goes with it (0069): `--platform`, else from the user's Team Roles, ties broken by the Platform the changed files point to (0052's hint, names only), else none, with a line saying how to ask for one.
- **A server endpoint** assembles the Hand-off within a token budget: the latest Spec first, the Feature's Decisions and open Decision Requests, the approved Design Doc (`GET /features/:id/design-docs/:key`'s newest version, 0069) and whether the Spec changed it since, the Project rules (the effective Feature Guidelines and the Project Brief, 0060's foundation) and retrieved chunks (ADR 0007, 0076's top-k), plus the Jira Epic key if linked.
  - Everyone in the Feature's Organization reads it, as they read the Feature; anyone else gets a 404.
  - Everything people wrote is fenced as untrusted data the assistant must not take as instructions; recognisable credentials are redacted.
  - The file asks the assistant to answer in the developer's Reply Language and keep terms, names, ids and numbers as written (0068).
  - A query budget and a bench scenario (0073, 0074).
- **Safe files:** only inside the repository's `.vorasaan/specs/`, never through a symlink, with a file name nothing can turn into a path; a .gitignore line is suggested when git would commit the file. The CLI's credentials never reach the file, the assistant's command line or its environment.

## Acceptance criteria (test first)
- [ ] Server, real Postgres: a Backend Role Owner's Hand-off has the Spec, the Decisions, the open Decision Requests, the Project rules, the retrieved Attachment and the Back-End Design Doc, in that order, with the Jira Epic key.
- [ ] The Design Doc is marked stale when the Spec changes what it covers, not otherwise.
- [ ] The Platform comes from `--platform` (id, name, `qa`, `none`; a 400 for an untargeted one), the Team Roles, the changed files' hint, or the only target; none otherwise, and the file says how to ask.
- [ ] The budget holds: a long Attachment is shortened, the Spec stays first, and the file is within its budget.
- [ ] Untrusted text can't close its data block, and credentials are redacted.
- [ ] Outside the Organization: 404. Nothing is written and no AI is called.
- [ ] A query budget for `GET /features/:id/hand-off`, in the bench.
- [ ] CLI, with a fake server and temp directories, no real assistant: the file is written where it should be and replaced on the next run; the assistant is started in the repository with the path only and without the credentials, or its command is printed; the Feature by id, title, file name, scope or picker; a symlinked `.vorasaan`, an unsafe name, another Feature's or someone's own file are never written through; the .gitignore tip.
