---
status: todo
depends-on: [0030]
slice: project-foundation
---

# 0033: Repo Scan from the CLI (opt-in)

## Goal
An existing codebase can tell Vorasaan what it already does, without sending source code (REQUIREMENT §3.8, ADR 0006).

## Scope
- `vorasaan scan --project <id>` (standalone, so it doesn't wait for `vorasaan init` in 0028; once 0028 lands, `vorasaan init --scan` calls it with the bound Project):
  - Collects: README(s), dependency manifests (package.json, go.mod, pyproject, Gemfile...), the top-level module/package tree (names only), and route or entry-point lists where they can be detected cheaply.
  - Respects `.gitignore` and skips anything that looks secret (`.env*`, keys).
  - Size-capped.
- **Always shows the summary and asks to confirm before sending.** `--dry-run` prints it without sending.
- Server: `POST /projects/:id/repo-scans` stores the summary as a Project Attachment with a new `AttachmentSource` `REPO_SCAN`. The newest scan is used by Grilling (0032) and Feature Suggestions (0034).

## Acceptance criteria
- [ ] CLI unit tests: a fixture repo produces the expected summary; `.env` and ignored files never appear; `--dry-run` sends nothing; declining the prompt sends nothing.
- [ ] API test: the scan is stored as a Project Attachment and only the Project's Role Owners or Admins can post one.
