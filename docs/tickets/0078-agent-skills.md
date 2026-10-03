---
status: todo
depends-on: [0060, 0065, 0070]
slice: agent-skills
---

# 0078: Agent Skills

## Goal
The AI inside Vorasaan can use Agent Skills an Admin installed and approved, in the open SKILL.md format, so a Skill such as [diagram-design](https://github.com/cathrynlavery/diagram-design) (MIT) works unchanged, and only ever leads to proposals (ADR 0017).

## Scope
- **Format:** a folder with `SKILL.md` (frontmatter with `name` and `description`), plus optional `references/` and `assets/`, the same format coding assistants use. No manifest of our own.
- **Install (Settings → Agent Skills, Admin):**
  - paste a GitHub URL, optionally with a subpath to the Skill's folder, or upload a zip;
  - the install is pinned to the commit it was fetched at, or to the zip's hash;
  - "Update" fetches the newer version and shows a diff (per file) before applying it; applying needs approval again;
  - uninstall removes the Skill and its files.
  Files are stored through the `FileStorage` interface.
- **Text and templates only:** no file in a Skill is ever executed. Scripts (`.py`, `.sh`, `.js`, binaries and the like) are skipped, and the Admin sees the list of skipped files on install and update.
- **Approval and enabling:** an installed or updated Skill needs an Admin's approval before the AI can use it, and is enabled per Project. A Skill that isn't approved, or isn't enabled in the Project, is invisible to the AI.
- **Safety:**
  - Skill content is untrusted input (prompt injection): it is fenced as data in the prompt, and it can only lead to proposals, never direct changes (ADR 0001, ADR 0008).
  - Size limits per Skill and per file (configurable).
  - Fetches go only to `https` GitHub and codeload hosts, and never follow a redirect off those hosts (SSRF).
- **How the AI uses them (progressive disclosure):**
  - only the name and description of the Project's enabled Skills go into the prompt;
  - a `loadSkill` tool reads a Skill's `SKILL.md`; a `readSkillFile` tool reads one reference or asset file at a time;
  - what they read counts against the context budget (0060);
  - available in Conversations and when drafting Spec Proposals, and in Design Docs once 0069 lands.
- **Output:** HTML or SVG made with a Skill (for example a diagram) is shown in a sandboxed iframe (no scripts, no network, a strict Content Security Policy). It is attached to a Spec or Design Doc only as a proposal a person approves, with Request changes (0065), and can be downloaded.
- **Measurement:** Receipts (0070) record which Skills each call loaded. The AI usage dashboard (0075) can show Skill usage and approve and decline rates per Skill.
- **Contracts:** Agent Skill, install, update diff and tool input schemas in `@vorasaan/shared`.

## Acceptance criteria (test first, real Postgres, a fake GitHub server + `FakeAiPort`)
- [ ] Install from a GitHub URL (with a subpath) and from a zip; the Skill is pinned to the commit or hash installed.
- [ ] Update fetches the newer version, shows a diff, and changes nothing until it is applied and approved.
- [ ] Scripts in a Skill are never executed and are listed as skipped.
- [ ] A disabled or unapproved Skill is invisible to the AI: not in the prompt, and `loadSkill` refuses it.
- [ ] `loadSkill` and `readSkillFile` read only inside the Project's enabled Skills; path traversal (`../`, absolute paths) is rejected.
- [ ] A URL off the allowed hosts, plain `http`, a redirect off-host, and a Skill or file over the size limits are refused.
- [ ] Only an Admin can install, update, approve or uninstall (403 otherwise).
- [ ] A Receipt records the Skills its call loaded.
- [ ] Browser-verified (e2e): a Skill's SVG renders in the sandboxed iframe, and a `<script>` inside it does not run.
