import type { PlatformRef } from '@vorasaan/shared';

/**
 * Which Platform (ADR 0009) a Decision Request is probably about, guessed from the files
 * changed in the repository (ticket 0052): `lib/**\/*.dart` → Flutter, `ios/` → Mobile,
 * `*.tsx` → Front-End, `server/` → Back-End. It is only a hint shown to the Raiser: the CLI
 * never fills in or sends anything from it. Naming the Platform in a Blocker's title is what
 * lets Coverage count the Blocker against that Platform.
 */

type Rule = {
  /** The name to suggest when no Platform of the Feature or Project matches `names`. */
  platform: string;
  /** Platform names this rule stands for, matched against the Project's own names. */
  names: RegExp;
  /** A directory anywhere in the path: these win over a file's extension. */
  dirs: RegExp;
  /** A file's extension or name. */
  files: RegExp;
};

export const PLATFORM_RULES: readonly Rule[] = [
  {
    platform: 'Flutter',
    names: /flutter|dart/i,
    dirs: /(^|\/)(flutter|dart)\//i,
    files: /\.dart$|(^|\/)pubspec\.(yaml|lock)$/i,
  },
  {
    platform: 'Mobile',
    names: /mobile|ios|android/i,
    dirs: /(^|\/)(ios|android|mobile)\//i,
    files: /\.(swift|kt|kts|m|mm|xib|storyboard|gradle)$|(^|\/)(Podfile|AndroidManifest\.xml)$/i,
  },
  {
    platform: 'Front-End',
    names: /front|web|client|\bui\b/i,
    dirs: /(^|\/)(web|frontend|front-end|client|ui|components|pages)\//i,
    files: /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i,
  },
  {
    platform: 'Back-End',
    names: /back|server|api/i,
    dirs: /(^|\/)(server|backend|back-end|api|migrations|prisma)\//i,
    files: /\.(go|py|java|rb|php|rs|cs|sql|ex|exs|scala|prisma)$/i,
  },
];

/** The rule a changed file points to: a directory first, then its extension. */
function ruleFor(file: string): Rule | undefined {
  return (
    PLATFORM_RULES.find((r) => r.dirs.test(file)) ?? PLATFORM_RULES.find((r) => r.files.test(file))
  );
}

export type PlatformSuggestion = {
  /** The Platform's name: one of `platforms` when one matches, else the rule's own. */
  name: string;
  /** Whether `name` is one of the given Platforms (the Feature's targets). */
  known: boolean;
  /** The changed files that point to it. */
  files: string[];
};

/**
 * The Platforms the changed files point to, the most files first. `platforms` are the
 * Feature's target Platforms: a match among them is named as the Project names it.
 */
export function suggestPlatforms(
  files: readonly string[],
  platforms: readonly PlatformRef[] = [],
): PlatformSuggestion[] {
  const byRule = new Map<Rule, string[]>();
  for (const file of files) {
    const rule = ruleFor(file);
    if (rule) byRule.set(rule, [...(byRule.get(rule) ?? []), file]);
  }
  return [...byRule.entries()]
    .map(([rule, matched]) => {
      const known = platforms.find((p) => rule.names.test(p.name));
      return { name: known?.name ?? rule.platform, known: Boolean(known), files: matched };
    })
    .sort((a, b) => b.files.length - a.files.length);
}

/** The line the Raiser reads, or undefined when the changed files point nowhere. */
export function platformHint(
  suggestions: readonly PlatformSuggestion[],
  hasTargets: boolean,
): string | undefined {
  const [top] = suggestions;
  if (!top) return undefined;
  const one = top.files.length === 1;
  const count = `${top.files.length} changed file${one ? '' : 's'}`;
  const example = `${top.files[0]}${one ? '' : ', …'}`;
  const line = `Hint: ${count} (${example}) ${one ? 'suggests' : 'suggest'} the ${top.name} Platform. If this is about ${top.name}, name it in the title so Coverage counts it there.`;
  return hasTargets && !top.known ? `${line} This Feature doesn't target ${top.name}.` : line;
}

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', '-c', 'core.quotepath=off', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files changed in the working tree: staged and unstaged against HEAD (the index before
 * the first commit), and untracked ones git doesn't ignore. Names only; nothing is read.
 */
export async function changedFiles(root: string): Promise<string[]> {
  const base = (await git(root, 'rev-parse', '--verify', '-q', 'HEAD')) ? ['HEAD'] : ['--cached'];
  const [changed, untracked] = await Promise.all([
    git(root, 'diff', ...base, '--name-only'),
    git(root, 'ls-files', '--others', '--exclude-standard'),
  ]);
  const names = `${changed ?? ''}\n${untracked ?? ''}`.split('\n').filter(Boolean);
  return [...new Set(names)];
}

/**
 * The hint for raising on `featureId` from the repository at `root`: its changed files
 * against the Feature's target Platforms. Never fails the raise: undefined on any error.
 */
export async function platformHintFor(
  api: { feature: (id: string) => Promise<{ platforms: PlatformRef[] }> },
  featureId: string,
  root: string,
): Promise<string | undefined> {
  try {
    const [files, feature] = await Promise.all([
      changedFiles(root),
      api.feature(featureId).catch(() => undefined),
    ]);
    const targets = feature?.platforms ?? [];
    return platformHint(suggestPlatforms(files, targets), targets.length > 0);
  } catch {
    return undefined;
  }
}
