import { z } from 'zod';
import { SpecDiffLine } from './spec.ts';

// Agent Skills (ADR 0017, ticket 0078): SKILL.md packages an Admin installs from GitHub or a
// zip, pinned, approved and enabled per Project. Text and templates only: nothing in them is
// ever run, and what the AI makes with one is only ever a proposal. Not Vorasaan's own
// prompts (those are `packages/skills` and Prompt Versions).

const Id = z.uuid();
const Timestamp = z.iso.datetime();

/** Where a Skill was installed from. */
export const AgentSkillSource = z.enum(['GITHUB', 'ZIP']);
export type AgentSkillSource = z.infer<typeof AgentSkillSource>;

/**
 * A fetched version of a Skill: PENDING until an Admin approves it (the AI never sees it),
 * then APPROVED (the active one) until a newer one is approved and it is REPLACED; or
 * DECLINED when an Admin discards it.
 */
export const AgentSkillVersionStatus = z.enum(['PENDING', 'APPROVED', 'DECLINED', 'REPLACED']);
export type AgentSkillVersionStatus = z.infer<typeof AgentSkillVersionStatus>;

/**
 * Why a file of a Skill was left out (never stored, never run): a script or program, a file
 * that isn't UTF-8 text (an image, a binary), or a symbolic link.
 */
export const SkippedSkillFileReason = z.enum(['SCRIPT', 'NOT_TEXT', 'LINK']);
export type SkippedSkillFileReason = z.infer<typeof SkippedSkillFileReason>;

export const SkippedSkillFile = z.object({ path: z.string(), reason: SkippedSkillFileReason });
export type SkippedSkillFile = z.infer<typeof SkippedSkillFile>;

/**
 * A folder within a repository or a zip: slash-separated names, no `..`, no leading slash.
 * Empty for the root.
 */
export const SkillSubpath = z
  .string()
  .trim()
  .max(300)
  .transform((s) => s.replace(/^\/+|\/+$/g, ''))
  .refine((s) => s === '' || s.split('/').every((part) => part && part !== '.' && part !== '..'), {
    message: 'A folder is slash-separated names, without "." or ".."',
  })
  .refine((s) => !/[\\\0]/.test(s), { message: 'A folder has no backslashes' });

/**
 * `POST /settings/agent-skills`: install from a GitHub URL, such as
 * `https://github.com/owner/repo`, `…/tree/<ref>/<folder>` or `…/blob/<ref>/<folder>/SKILL.md`.
 * `subpath` names the Skill's folder when the URL doesn't.
 */
export const InstallAgentSkillInput = z.strictObject({
  url: z.string().trim().min(1, 'Paste a GitHub URL').max(500),
  subpath: SkillSubpath.optional(),
});
export type InstallAgentSkillInput = z.infer<typeof InstallAgentSkillInput>;

/** The fields of a zip upload (`POST /settings/agent-skills/zip`), besides its `file` part. */
export const UploadAgentSkillFields = z.object({ subpath: SkillSubpath.optional() });
export type UploadAgentSkillFields = z.infer<typeof UploadAgentSkillFields>;

/** `PUT /settings/agent-skills/:id/projects`: every Project the Skill is enabled in. */
export const SetAgentSkillProjectsInput = z.strictObject({
  projectIds: z
    .array(Id)
    .max(1_000)
    .transform((ids) => [...new Set(ids)]),
});
export type SetAgentSkillProjectsInput = z.infer<typeof SetAgentSkillProjectsInput>;

export const AgentSkillFileView = z.object({ path: z.string(), bytes: z.int().min(0) });
export type AgentSkillFileView = z.infer<typeof AgentSkillFileView>;

export const AgentSkillVersionView = z.object({
  id: Id,
  number: z.int().min(1),
  status: AgentSkillVersionStatus,
  /** The commit SHA it was fetched at, or `sha256:<hex>` of the zip. */
  pinned: z.string(),
  name: z.string(),
  description: z.string(),
  license: z.string().nullable(),
  files: z.array(AgentSkillFileView),
  skipped: z.array(SkippedSkillFile),
  totalBytes: z.int().min(0),
  fetchedAt: Timestamp,
  fetchedBy: z.string().nullable(),
  decidedAt: Timestamp.nullable(),
  decidedBy: z.string().nullable(),
});
export type AgentSkillVersionView = z.infer<typeof AgentSkillVersionView>;

export const AgentSkillView = z.object({
  id: Id,
  name: z.string(),
  source: AgentSkillSource,
  /** GITHUB: "owner/repo". */
  repository: z.string().nullable(),
  /** GITHUB: the branch, tag or commit asked for; null for the default branch. */
  ref: z.string().nullable(),
  subpath: z.string(),
  /** A link to where it came from (GITHUB), pinned to the active or pending commit. */
  sourceUrl: z.string().nullable(),
  /** The approved version the AI uses in the Projects it is enabled in; null until approved. */
  active: AgentSkillVersionView.nullable(),
  /** A version waiting for a decision (the install, or an update); invisible to the AI. */
  pending: AgentSkillVersionView.nullable(),
  /** The Projects it is enabled in. */
  projectIds: z.array(Id),
  installedAt: Timestamp,
  installedBy: z.string().nullable(),
});
export type AgentSkillView = z.infer<typeof AgentSkillView>;

/** The size limits an install or update is held to (configurable on the server). */
export const AgentSkillLimits = z.object({
  /** All kept files of one Skill together. */
  maxSkillBytes: z.int().min(1),
  /** One kept file. */
  maxFileBytes: z.int().min(1),
  /** Kept files in one Skill. */
  maxFiles: z.int().min(1),
  /** A zip uploaded or downloaded from GitHub, as a whole. */
  maxArchiveBytes: z.int().min(1),
});
export type AgentSkillLimits = z.infer<typeof AgentSkillLimits>;

/** `GET /settings/agent-skills` (Admins). */
export const AgentSkillsView = z.object({
  skills: z.array(AgentSkillView),
  /** Every Project, to enable a Skill in. */
  projects: z.array(z.object({ id: Id, name: z.string() })),
  limits: AgentSkillLimits,
});
export type AgentSkillsView = z.infer<typeof AgentSkillsView>;

/** `POST /settings/agent-skills/:id/update[/zip]`: the Skill, and whether nothing was newer. */
export const AgentSkillUpdateResult = z.object({ skill: AgentSkillView, upToDate: z.boolean() });
export type AgentSkillUpdateResult = z.infer<typeof AgentSkillUpdateResult>;

export const AgentSkillFileChange = z.enum(['ADDED', 'REMOVED', 'CHANGED', 'UNCHANGED']);
export type AgentSkillFileChange = z.infer<typeof AgentSkillFileChange>;

/**
 * `GET /settings/agent-skills/:id/diff`: the pending version against the active one (every
 * file ADDED on a first install), file by file, so an Admin reads what the AI would get
 * before approving it. Unchanged files carry no lines.
 */
export const AgentSkillDiff = z.object({
  /** The active version's number; null on a first install. */
  from: z.int().min(1).nullable(),
  to: z.int().min(1),
  files: z.array(
    z.object({ path: z.string(), change: AgentSkillFileChange, lines: z.array(SpecDiffLine) }),
  ),
  skipped: z.array(SkippedSkillFile),
});
export type AgentSkillDiff = z.infer<typeof AgentSkillDiff>;

// ─── The AI's tools (progressive disclosure) ────────────────────────────────

/** A Skill's name as SKILL.md gives it, as the AI names it in a tool call. */
const SkillNameArg = z.string().trim().min(1).max(100);

/** `loadSkill`: reads one enabled, approved Skill's SKILL.md and lists its other files. */
export const LoadSkillArgs = z.object({ name: SkillNameArg });
export type LoadSkillArgs = z.infer<typeof LoadSkillArgs>;

/** `readSkillFile`: reads one reference or asset of an enabled, approved Skill, by its path. */
export const ReadSkillFileArgs = z.object({
  name: SkillNameArg,
  path: z.string().trim().min(1).max(300),
});
export type ReadSkillFileArgs = z.infer<typeof ReadSkillFileArgs>;
