import { BadRequestException } from '@nestjs/common';
import type { DesignDocKey, HandOffPlatformChoice, TeamRole } from '@vorasaan/shared';

/** A target Platform of the Feature, in its Project's order. */
export type HandOffTarget = { id: string; name: string; roles: readonly TeamRole[] };

export type ChosenPlatform = {
  key: DesignDocKey;
  name: string;
  /** Null for the QA Design Doc. */
  platform: HandOffTarget | null;
  chosenBy: HandOffPlatformChoice;
};

/** `--platform none`: hand over no Design Doc. */
export const NO_PLATFORM = 'none';

/** Platform names compare case-insensitively, as a Spec section matches its name. */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const qa = (chosenBy: HandOffPlatformChoice): ChosenPlatform => ({
  key: 'qa',
  name: 'QA',
  platform: null,
  chosenBy,
});
const of = (t: HandOffTarget, chosenBy: HandOffPlatformChoice): ChosenPlatform => ({
  key: t.id,
  name: t.name,
  platform: t,
  chosenBy,
});

/**
 * Whose Design Doc a developer's Hand-off carries (ticket 0079):
 *
 * 1. the one asked for (`--platform`: a target's id or name, `qa`, or `none` for no Design Doc);
 * 2. else the target Platforms one of the developer's Team Roles answers for (a Role Owner's
 *    roles on the Feature and their roles in its Team): the only one, or among several the
 *    first the changed files point to, else the first in the Project's order; with none of
 *    them but QA held, the QA Design Doc;
 * 3. else the first target the changed files point to, or the Feature's only target;
 * 4. else none: the Hand-off says how to ask for one.
 *
 * Tech Lead answers for every Platform, so it alone picks nothing. `hints` are Platform names,
 * best first. An unknown or untargeted `asked` is a 400 naming what may be asked for.
 */
export function chooseHandOffPlatform(input: {
  targets: readonly HandOffTarget[];
  roles: ReadonlySet<TeamRole>;
  asked?: string;
  hints?: readonly string[];
}): ChosenPlatform | null {
  const { targets, roles } = input;
  const hints = input.hints ?? [];
  const asked = input.asked?.trim();
  if (asked) {
    if (same(asked, NO_PLATFORM)) return null;
    if (same(asked, 'qa')) return qa('ASKED');
    const found = targets.find((t) => t.id === asked || same(t.name, asked));
    if (found) return of(found, 'ASKED');
    const names = [...targets.map((t) => t.name), 'qa', NO_PLATFORM];
    throw new BadRequestException(
      `This Feature doesn't target a Platform "${asked}". Ask for one of: ${names.join(', ')}`,
    );
  }
  const hinted = (among: readonly HandOffTarget[]) =>
    hints.map((h) => among.find((t) => same(t.name, h))).find((t) => t !== undefined);

  const mine = targets.filter((t) => t.roles.some((r) => r !== 'TECH_LEAD' && roles.has(r)));
  if (mine.length === 1 && mine[0]) return of(mine[0], 'TEAM_ROLE');
  if (mine.length > 1) {
    const fromFiles = hinted(mine);
    if (fromFiles) return of(fromFiles, 'CHANGED_FILES');
    return of(mine[0] as HandOffTarget, 'TEAM_ROLE');
  }
  if (roles.has('QA')) return qa('TEAM_ROLE');
  const fromFiles = hinted(targets);
  if (fromFiles) return of(fromFiles, 'CHANGED_FILES');
  if (targets.length === 1 && targets[0]) return of(targets[0], 'ONLY_TARGET');
  return null;
}

/** The hint parameter: names separated by commas, blanks dropped, at most ten. */
export function parseHints(hint: string | undefined): string[] {
  return (hint ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .slice(0, 10);
}
