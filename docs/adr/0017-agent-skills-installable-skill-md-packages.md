# Agent Skills: installable SKILL.md packages, text only, approved by an Admin

The AI inside Vorasaan knows only what our built-in prompts in `packages/skills` and an Organization's Prompt Versions (ADR 0015) tell it. Teams want it to do more in their own way: draw a diagram of a flow in a Spec, write a Design Doc in their house style, follow a checklist they already use. Coding assistants solve this with **Agent Skills** in the open SKILL.md format: a folder with a `SKILL.md` whose frontmatter has a `name` and a `description`, plus optional `references/` and `assets/`. The same folder works in several assistants, and many are published on GitHub. For example [diagram-design](https://github.com/cathrynlavery/diagram-design) (MIT) should work in Vorasaan unchanged.

We let an Organization install **Agent Skills**:

- **The open format, unchanged.** A Skill is a folder with `SKILL.md` (`name` and `description` frontmatter), `references/` and `assets/`. We don't add our own manifest, so a Skill written for a coding assistant installs as it is.
- **Installed by an Admin, pinned.** An Admin pastes a GitHub URL (optionally a subpath) or uploads a zip. The install is pinned to the commit, or to the zip's hash. "Update" fetches the newer version and shows a diff before anything changes; an Admin can uninstall. Files are stored through the `FileStorage` interface.
- **Text and templates only.** Vorasaan never executes anything in a Skill. Scripts (`.py`, `.sh` and the like) are skipped, and the Admin sees the list of skipped files. A Skill that needs its scripts to work doesn't work in Vorasaan, and that is accepted.
- **Approved, then enabled per Project.** Every installed Skill, and every update, needs an Admin's approval before the AI can use it, and is then enabled per Project. A disabled or unapproved Skill is invisible to the AI.
- **Untrusted input.** Skill content is treated like Attachment content: it is fenced as data in the prompt, and it can only lead to proposals. Nothing a Skill says changes a Spec, a Design Doc or anything else without a person's approval (ADR 0001, ADR 0008).
- **Progressive disclosure.** Only the name and description of the Project's enabled Skills go into the prompt. The AI calls `loadSkill` to read a `SKILL.md`, and `readSkillFile` to read one reference or asset at a time, only inside enabled Skills. What it reads counts against the context budget (ADR 0012).
- **Output is a proposal.** HTML or SVG made with a Skill (a diagram, say) is shown in a sandboxed iframe with no scripts and no network, and reaches a Spec or Design Doc only as a proposal a person approves. It can also be downloaded.
- **Measured.** Receipts (ADR 0015) record which Skills a call loaded, so the AI usage dashboard can show Skill usage and approve and decline rates.

## Rejected

- **Running a Skill's scripts in a sandbox.** It would make many more Skills work, but a sandbox that safely runs arbitrary Python and shell on every self-hosted install is a large attack surface and a lot to operate. Text and templates cover the Skills we want first.
- **An MCP server per Skill.** Heavier for each install, needs a process per Skill, and the format most Skills are published in is plain files, not servers.
- **Only built-in prompts.** Safe and simple, but every new ability would wait for us to write it, and teams couldn't bring the Skills they already use.

## Consequences

- Installing from GitHub means fetching from the internet on the server. Fetches go only to `https` GitHub and codeload hosts, never follow a redirect off those hosts, and are capped in size per Skill and per file, so a URL can't be used to reach internal services (SSRF).
- A Skill can try to steer the AI (prompt injection). Fencing, Admin approval, per-Project enabling and "only proposals" limit what that can do; a person still approves every change.
- Rendering AI-made HTML or SVG in the web app needs a strict sandbox and Content Security Policy, tested in the browser.
- The word "skill" now means two things in the code. `packages/skills` keeps Vorasaan's own prompts (Prompt Versions sit on top of them); an Agent Skill is an installed SKILL.md package. CONTEXT.md keeps the terms apart.
