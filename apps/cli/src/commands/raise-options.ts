import { DecisionRequestKind, TeamRole } from '@vorasaan/shared';

/** Raw Commander options for `vorasaan raise`. */
export type RaiseFlags = {
  feature?: string;
  kind?: string;
  title?: string;
  description?: string;
  deciderRole?: string;
  choices?: boolean; // --no-choices sets false
  yes?: boolean;
  diff?: boolean;
  file?: string[];
};

export type RaiseOptions = {
  featureId?: string;
  kind?: DecisionRequestKind;
  title?: string;
  description?: string;
  deciderRole?: TeamRole;
  withChoices: boolean;
  /** Send without the interactive review. */
  yes: boolean;
  /** Attach the current `git diff HEAD` as context. */
  diff?: boolean;
  /** Attach these repository files as context. */
  files?: string[];
};

export class UsageError extends Error {}

export function parseRaiseFlags(flags: RaiseFlags): RaiseOptions {
  const kind = flags.kind?.toUpperCase();
  if (kind !== undefined && !DecisionRequestKind.safeParse(kind).success) {
    throw new UsageError(`--kind must be "blocker" or "question", got "${flags.kind}"`);
  }
  const deciderRole = flags.deciderRole?.toUpperCase().replace('-', '_');
  if (deciderRole !== undefined && !TeamRole.safeParse(deciderRole).success) {
    throw new UsageError(
      `--decider-role must be one of ${TeamRole.options.map((r) => r.toLowerCase()).join(', ')}`,
    );
  }
  const options: RaiseOptions = {
    featureId: flags.feature,
    kind: kind as DecisionRequestKind | undefined,
    title: flags.title,
    description: flags.description,
    deciderRole: deciderRole as TeamRole | undefined,
    withChoices: flags.choices !== false,
    yes: flags.yes === true,
    ...(flags.diff ? { diff: true } : {}),
    ...(flags.file?.length ? { files: flags.file } : {}),
  };
  if (options.yes) {
    const missing = (['featureId', 'title', 'description'] as const).filter((k) => !options[k]);
    if (missing.length) {
      const names = { featureId: '--feature', title: '--title', description: '--description' };
      throw new UsageError(`--yes needs ${missing.map((k) => names[k]).join(', ')}`);
    }
  }
  if (options.kind === 'BLOCKER' && !options.withChoices) {
    throw new UsageError('--no-choices is only allowed for questions (--kind question)');
  }
  return options;
}
