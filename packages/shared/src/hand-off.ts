import { z } from 'zod';
import { DesignDocKey } from './design-doc.ts';

// The Hand-off (REQUIREMENT 15, ticket 0079): one Feature's distilled context as one Markdown
// file, which `vorasaan run` writes to `.vorasaan/specs/<feature>.md` for a coding assistant.

/** The Hand-off's size in tokens: by default, and the range `--budget` may ask for. */
export const HAND_OFF_BUDGET = { default: 24_000, min: 4_000, max: 64_000 } as const;

/** The longest file name (without `.md`) a Hand-off gets. */
export const MAX_HAND_OFF_SLUG = 60;

/**
 * `GET /features/:id/hand-off`. `platform` is a target Platform's id or name, `qa`, or `none`
 * (no Design Doc); without it the server picks one. `hint` is the Platform names the changed
 * files suggest (`vorasaan raise`'s hint, ticket 0052), best first, comma-separated.
 */
export const HandOffQuery = z.object({
  platform: z.string().trim().min(1).max(200).optional(),
  hint: z.string().max(1_000).optional(),
  budget: z.coerce.number().int().min(HAND_OFF_BUDGET.min).max(HAND_OFF_BUDGET.max).optional(),
});
export type HandOffQuery = z.infer<typeof HandOffQuery>;

/**
 * How the Hand-off's Platform was picked:
 * - ASKED: `--platform`;
 * - TEAM_ROLE: one of the developer's Team Roles answers for it (QA for the QA Design Doc);
 * - CHANGED_FILES: several (or none) of their Team Roles fit, and the changed files point to it;
 * - ONLY_TARGET: the Feature targets only this Platform.
 */
export const HandOffPlatformChoice = z.enum(['ASKED', 'TEAM_ROLE', 'CHANGED_FILES', 'ONLY_TARGET']);
export type HandOffPlatformChoice = z.infer<typeof HandOffPlatformChoice>;

export const HandOffView = z.object({
  featureId: z.uuid(),
  title: z.string(),
  /** The file name `vorasaan run` writes it to, without `.md` (`handOffSlug`). */
  slug: z.string(),
  projectName: z.string(),
  teamName: z.string(),
  jiraIssueKey: z.string().nullable(),
  jiraIssueUrl: z.string().nullable(),
  /** The latest Spec Version; null before the first. */
  specVersion: z.int().positive().nullable(),
  /** The Platform whose Design Doc is handed over; null when none was picked. */
  platform: z
    .object({ key: DesignDocKey, name: z.string(), chosenBy: HandOffPlatformChoice })
    .nullable(),
  /** Every Design Doc the developer could ask for instead (`--platform`). */
  platforms: z.array(z.object({ key: DesignDocKey, name: z.string() })),
  /** The approved Design Doc handed over: its newest version. */
  designDoc: z
    .object({
      name: z.string(),
      version: z.int().positive(),
      /** The Spec Version it follows. */
      specVersion: z.int().positive(),
      /** The latest Spec changed what it covers: an update is on its way. */
      stale: z.boolean(),
    })
    .nullable(),
  /** Why no Design Doc is handed over, in words; null when one is. */
  designDocNote: z.string().nullable(),
  tokens: z.object({ budget: z.int().positive(), used: z.int().nonnegative() }),
  /** The file's content. */
  markdown: z.string(),
});
export type HandOffView = z.infer<typeof HandOffView>;

/**
 * A Feature's Hand-off file name: its title's letters and digits in any script (Thai
 * included), lowercased and joined by `-`, at most MAX_HAND_OFF_SLUG characters; with none,
 * `feature-` and the start of its id. It never holds a dot, a slash or a backslash, so it can't
 * leave `.vorasaan/specs/`.
 */
export function handOffSlug(title: string, featureId: string): string {
  const words =
    title
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_HAND_OFF_SLUG) break;
    slug = next;
  }
  if (!slug && words[0]) slug = words[0].slice(0, MAX_HAND_OFF_SLUG);
  return (
    slug ||
    `feature-${featureId
      .replace(/[^0-9a-f]/gi, '')
      .slice(0, 8)
      .toLowerCase()}`
  );
}

/** Whether `name` is a file name `handOffSlug` could make: nothing that can leave its folder. */
export function isHandOffSlug(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_HAND_OFF_SLUG + 9 &&
    /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u.test(name)
  );
}

const REDACTED = '[redacted: looks like a credential]';

/**
 * Credentials with a recognisable shape (private keys, cloud and Git hosting keys, AI and
 * payment keys, Slack tokens, JWTs, Vorasaan access tokens, passwords in URLs). A Hand-off
 * goes to a coding assistant, which may send it to its own AI provider: anything like these
 * that people pasted into an Attachment or a Spec is replaced, not handed on.
 */
const CREDENTIALS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bvsp_[A-Za-z0-9_-]{8,}/g,
];
/** `scheme://user:password@host`: only the password goes. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi;

/** `text` with every recognisable credential replaced. */
export function redactCredentials(text: string): string {
  let out = text;
  for (const re of CREDENTIALS) out = out.replace(re, REDACTED);
  return out.replace(URL_PASSWORD, `$1${REDACTED}@`);
}
