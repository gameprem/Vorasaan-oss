---
status: done
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
- [x] CLI unit tests: a fixture repo produces the expected summary; `.env` and ignored files never appear; `--dry-run` sends nothing; declining the prompt sends nothing.
- [x] API test: the scan is stored as a Project Attachment and only the Project's Role Owners or Admins can post one.

## Decisions
- **Who may post:** Admins, POs of the Project's Teams (the Project's editors, as for Project Attachments) and Role Owners of any Feature in the Project, since they work in its code. Removing a Repo Scan Attachment still follows the Project Attachment rules.
- **Retention:** a new Repo Scan replaces the Project's previous one (deleted and removed from the index), so only the newest is used as context and older ones never surface in retrieval.
- **Refresh:** a `REPO_SCAN` Attachment can't be re-fetched; `POST /attachments/:id/refresh` returns 422 with a hint to run `vorasaan scan` again.
- **What is collected:** READMEs at the root and at the top of packages (a directory up to two levels deep with a manifest; 8 KB each), names and dependency names from manifests (package.json, go.mod, pyproject.toml, requirements.txt, Gemfile, Cargo.toml, pom.xml, build.gradle), the module tree (names only, 3 levels, 40 entries per directory), and routes and entry points found by file name and single-line patterns. The file list is the repository's tracked and unignored files (so `.gitignore` applies), or a directory walk outside a repository, minus a fixed ignore list, secret-looking files and symlinks. Lines that look like credentials are redacted; the whole summary is capped at 200 KB and lists what was cut.
- Without a terminal, `vorasaan scan` refuses to ask: check the summary with `--dry-run`, then pass `--yes`.
