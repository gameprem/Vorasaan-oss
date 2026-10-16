import { z } from 'zod';
import { TeamRole } from './enums.ts';
import { PlatformRef } from './platform.ts';

// Coverage (ADR 0009, ticket 0051): for each Feature and each of its target Platforms,
// whether that Platform is covered or missing, and why, using only the checks the Platform
// switches on. The rules are pure functions here, so the server, the AI's inputs and any
// client read a Spec the same way.

const Id = z.uuid();

/** The four checks a Platform can switch on (its `specSection`... flags). */
export const CoverageCheck = z.enum([
  'SPEC_SECTION',
  'SOMEONE_TO_ASK',
  'NO_OPEN_BLOCKERS',
  'QA_READY',
]);
export type CoverageCheck = z.infer<typeof CoverageCheck>;

/** Why a target Platform is missing: one entry per check that fails. */
export const CoverageGap = z.discriminatedUnion('check', [
  /** The latest Spec Version has no non-empty `## <Platform>` section. */
  z.object({ check: z.literal('SPEC_SECTION') }),
  /** Nobody in the Feature's Team holds one of these Team Roles (the Platform's). */
  z.object({ check: z.literal('SOMEONE_TO_ASK'), roles: z.array(TeamRole) }),
  /** Open Blockers that name the Platform in their title or Choices. */
  z.object({
    check: z.literal('NO_OPEN_BLOCKERS'),
    blockers: z.array(z.object({ id: Id, title: z.string() })),
  }),
  /**
   * `noCriteria`: the Platform's section has no non-empty "Acceptance criteria" or "Test
   * cases" subsection. `noQa`: nobody in the Team holds QA. At least one is true.
   */
  z.object({ check: z.literal('QA_READY'), noCriteria: z.boolean(), noQa: z.boolean() }),
]);
export type CoverageGap = z.infer<typeof CoverageGap>;

/** One target Platform of a Feature: covered when nothing is `missing`. */
export const PlatformCoverage = z.object({
  platform: PlatformRef,
  covered: z.boolean(),
  /** The checks this Platform switches on, in the order above; only these are evaluated. */
  checks: z.array(CoverageCheck),
  missing: z.array(CoverageGap),
});
export type PlatformCoverage = z.infer<typeof PlatformCoverage>;

/** `GET /features/:id/coverage`. */
export const FeatureCoverageView = z.object({
  featureId: Id,
  /** The Spec Version read (the latest); null before the first. */
  specVersion: z.int().positive().nullable(),
  /** Every target Platform is covered (also true when it targets none). */
  covered: z.boolean(),
  /** Its target Platforms, in the Project's order. */
  platforms: z.array(PlatformCoverage),
});
export type FeatureCoverageView = z.infer<typeof FeatureCoverageView>;

/** One row of a Project's Coverage matrix: a Feature and the Platforms it targets. */
export const FeatureCoverageRow = z.object({
  featureId: Id,
  title: z.string(),
  teamId: Id,
  teamName: z.string(),
  specVersion: z.int().positive().nullable(),
  covered: z.boolean(),
  /** Only the Platforms it targets; a column it doesn't target has no cell. */
  platforms: z.array(PlatformCoverage),
});
export type FeatureCoverageRow = z.infer<typeof FeatureCoverageRow>;

/** `GET /projects/:id/coverage`: the Feature × Platform matrix. */
export const ProjectCoverageView = z.object({
  projectId: Id,
  /** The columns: the Project's Platforms, in order. */
  platforms: z.array(PlatformRef),
  /** The rows: every Feature of the Project's Teams, by title. */
  features: z.array(FeatureCoverageRow),
  /** Platforms no Feature covers: none targets them, or none that does is covered on them. */
  uncovered: z.array(PlatformRef),
});
export type ProjectCoverageView = z.infer<typeof ProjectCoverageView>;

/** `POST /features/:id/coverage/acceptance-criteria`: draft a Platform's acceptance criteria. */
export const DraftAcceptanceCriteriaInput = z.object({ platformId: Id });
export type DraftAcceptanceCriteriaInput = z.infer<typeof DraftAcceptanceCriteriaInput>;

// ─── Reading a Spec ─────────────────────────────────────────────────────────

/**
 * The `###` subsection titles that make a Platform's section QA ready, compared ignoring
 * case: English or Thai.
 */
export const ACCEPTANCE_HEADINGS = [
  'acceptance criteria',
  'test cases',
  'เกณฑ์การยอมรับ',
  'กรณีทดสอบ',
] as const;

/** One heading of a Spec, with the lines its section spans (`end` excluded). */
export type SpecHeading = { level: number; text: string; line: number; end: number };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A heading's text as compared: trimmed, one space between words, lower case, no final ":". */
export function headingKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\s*:$/, '').toLowerCase();
}

/**
 * The ATX headings of a Spec, outside code fences, each with where its section ends: the
 * next heading of the same or a higher level, or the end.
 */
export function specHeadings(markdown: string): { lines: string[]; headings: SpecHeading[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headings: SpecHeading[] = [];
  let fence: string | null = null;
  for (const [i, line] of lines.entries()) {
    const marker = line.match(FENCE)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = line.match(HEADING);
    if (m)
      headings.push({
        level: m[1]?.length ?? 1,
        text: (m[2] ?? '').trim(),
        line: i,
        end: lines.length,
      });
  }
  for (const [i, h] of headings.entries()) {
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    if (next) h.end = next.line;
  }
  return { lines, headings };
}

/** A line that says nothing: blank, a heading, a fence marker, a comment or a "…" placeholder. */
function isEmptyLine(line: string): boolean {
  const text = line.trim();
  if (!text) return true;
  if (HEADING.test(line) || FENCE.test(line)) return true;
  if (/^<!--.*-->$/.test(text) || /^([-*_])\1{2,}$/.test(text.replace(/\s+/g, ''))) return true;
  return /^(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]?\])?\s*(?:…|\.{3})?$/.test(text);
}

/** Whether these lines hold any content besides headings and placeholders. */
export function hasContent(lines: readonly string[]): boolean {
  return lines.some((l) => !isEmptyLine(l));
}

/** The `##` sections of a Spec whose heading is `name` (ignoring case), as their lines. */
export function platformSections(markdown: string, name: string): string[][] {
  const { lines, headings } = specHeadings(markdown);
  const key = headingKey(name);
  return headings
    .filter((h) => h.level === 2 && headingKey(h.text) === key)
    .map((h) => lines.slice(h.line + 1, h.end));
}

/** Whether the Spec has a `## <name>` section with content under it. */
export function hasPlatformSection(markdown: string, name: string): boolean {
  return platformSections(markdown, name).some(hasContent);
}

/**
 * Whether the Platform's section has a non-empty `###` "Acceptance criteria" or "Test
 * cases" subsection (English or Thai).
 */
export function hasAcceptanceCriteria(markdown: string, name: string): boolean {
  return platformSections(markdown, name).some((section) => {
    const { lines, headings } = specHeadings(section.join('\n'));
    return headings.some(
      (h) =>
        h.level === 3 &&
        (ACCEPTANCE_HEADINGS as readonly string[]).includes(headingKey(h.text)) &&
        hasContent(lines.slice(h.line + 1, h.end)),
    );
  });
}

/**
 * Whether `text` names the Platform: its words in order, as a whole word, ignoring case
 * and how they are joined, so "Back-End" matches "backend" and "back end". Thai has no
 * spaces between words, so only Latin letters and digits mark a word's edge.
 */
export function namesPlatform(text: string, name: string): boolean {
  const words = name.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return false;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])${escaped.join('[\\s\\-_./]*')}(?![A-Za-z0-9])`,
    'iu',
  );
  return pattern.test(text);
}

// ─── Evaluating ─────────────────────────────────────────────────────────────

/** A Platform as Coverage reads it: its name, Team Roles and switched-on checks. */
export type CoveragePlatform = {
  id: string;
  name: string;
  roles: readonly TeamRole[];
  specSection: boolean;
  someoneToAsk: boolean;
  noOpenBlockers: boolean;
  qaReady: boolean;
};

/** An open Blocker as Coverage reads it: its title and its Choices' titles and descriptions. */
export type CoverageBlocker = { id: string; title: string; choices: readonly string[] };

/** One target Platform's Coverage, from the latest Spec, the Team's roles and the open Blockers. */
export function platformCoverage(input: {
  platform: CoveragePlatform;
  /** The latest Spec Version's Markdown; null before the first. */
  specMarkdown: string | null;
  /** Every Team Role someone in the Feature's Team holds. */
  teamRoles: ReadonlySet<TeamRole>;
  /** The Feature's open Blockers (OPEN or NEEDS_INFO). */
  openBlockers: readonly CoverageBlocker[];
}): PlatformCoverage {
  const { platform, teamRoles } = input;
  const spec = input.specMarkdown ?? '';
  const checks: CoverageCheck[] = [];
  const missing: CoverageGap[] = [];
  if (platform.specSection) {
    checks.push('SPEC_SECTION');
    if (!hasPlatformSection(spec, platform.name)) missing.push({ check: 'SPEC_SECTION' });
  }
  if (platform.someoneToAsk) {
    checks.push('SOMEONE_TO_ASK');
    if (!platform.roles.some((r) => teamRoles.has(r))) {
      missing.push({ check: 'SOMEONE_TO_ASK', roles: [...platform.roles] });
    }
  }
  if (platform.noOpenBlockers) {
    checks.push('NO_OPEN_BLOCKERS');
    const blockers = input.openBlockers
      .filter((b) => [b.title, ...b.choices].some((t) => namesPlatform(t, platform.name)))
      .map((b) => ({ id: b.id, title: b.title }));
    if (blockers.length) missing.push({ check: 'NO_OPEN_BLOCKERS', blockers });
  }
  if (platform.qaReady) {
    checks.push('QA_READY');
    const noCriteria = !hasAcceptanceCriteria(spec, platform.name);
    const noQa = !teamRoles.has('QA');
    if (noCriteria || noQa) missing.push({ check: 'QA_READY', noCriteria, noQa });
  }
  return {
    platform: { id: platform.id, name: platform.name },
    covered: missing.length === 0,
    checks,
    missing,
  };
}

/** The Platforms of a list no Feature covers, in the list's order. */
export function uncoveredPlatforms(
  platforms: readonly PlatformRef[],
  rows: readonly { platforms: readonly PlatformCoverage[] }[],
): PlatformRef[] {
  const covered = new Set(
    rows.flatMap((r) => r.platforms.filter((p) => p.covered).map((p) => p.platform.id)),
  );
  return platforms.filter((p) => !covered.has(p.id));
}
