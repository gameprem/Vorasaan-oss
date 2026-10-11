import * as p from '@clack/prompts';
import {
  type FeatureSummaryView,
  type HandOffView,
  handOffSlug,
  redactCredentials,
} from '@vorasaan/shared';
import type { VorasaanApi } from '../api.ts';
import {
  ASSISTANTS,
  type AssistantName,
  assistantCommand,
  assistantEnv,
  handOffPrompt,
} from '../assistants.ts';
import { gitIgnores, HAND_OFF_RELATIVE_DIR, writeHandOff } from '../hand-off-file.ts';
import { type CurrentRepo, isUuid } from '../repo.ts';
import { changedFiles, suggestPlatforms } from './platform-hint.ts';
import { noFeaturesMessage } from './raise-flow.ts';
import { UsageError } from './raise-options.ts';

export type RunOptions = {
  /** A Feature id, or a Feature's title or file name (one the user is a Role Owner of). */
  feature?: string;
  /** The coding assistant to start; without it the command to start one is printed. */
  ai?: AssistantName;
  /** A target Platform's name or id, `qa`, or `none`; the server picks one without it. */
  platform?: string;
  /** The Hand-off's size in tokens. */
  budget?: number;
  /** Start the assistant (`--no-launch` only writes the file and prints the command). */
  launch: boolean;
};

export type RunApi = Pick<VorasaanApi, 'listFeatures' | 'feature' | 'handOff'>;

export type RunDeps = {
  api: RunApi;
  repo: CurrentRepo;
  /** Never written to the file: the credentials the CLI holds. */
  secrets: string[];
  /** The Feature picker; undefined when the user cancels. */
  pickFeature: (features: FeatureSummaryView[]) => Promise<string | undefined>;
  print: (text: string) => void;
  /** Whether a person is at the terminal (stdin and stdout are TTYs). */
  interactive: boolean;
  /** Finds an executable on PATH. */
  which: (bin: string) => string | null;
  /** Runs the assistant in the foreground; resolves with its exit code. */
  spawn: (
    command: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<number>;
  env: Record<string, string | undefined>;
  /** The changed files the Platform hint is read from (ticket 0052); injectable for tests. */
  changedFiles?: (root: string) => Promise<string[]>;
};

export type RunResult = {
  /** Undefined when the user cancelled the picker. */
  path?: string;
  view?: HandOffView;
  /** The assistant's exit code when it was started, else 0. */
  exitCode: number;
  /** Whether the assistant was started. */
  launched: boolean;
};

const lower = (s: string) => s.normalize('NFC').trim().toLowerCase();

/**
 * The Feature `--feature` names: an id as given, else the user's Features (as Role Owner)
 * whose title or file name matches, those of the bound Project first. Without it: the only
 * Feature in scope, or the picker.
 */
async function resolveFeature(options: RunOptions, deps: RunDeps): Promise<string | undefined> {
  const asked = options.feature?.trim();
  if (asked && isUuid(asked)) return asked;
  const features = await deps.api.listFeatures();
  const projectId = deps.repo.projectId;
  if (asked) {
    const slug = handOffSlug(asked, '');
    const matches = features.filter(
      (f) => lower(f.title) === lower(asked) || handOffSlug(f.title, f.id) === slug,
    );
    const inProject = matches.filter((f) => f.projectId === projectId);
    const found = inProject.length ? inProject : matches;
    if (found.length === 1 && found[0]) return found[0].id;
    if (found.length === 0) {
      throw new UsageError(
        `No Feature you are a Role Owner of is called "${asked}". Pass its id (from its page in the web app).`,
      );
    }
    throw new UsageError(
      `"${asked}" matches several Features; pass one's id:\n${found.map((f) => `  ${f.id}  ${f.title} (${f.projectName})`).join('\n')}`,
    );
  }
  const inScope = projectId ? features.filter((f) => f.projectId === projectId) : features;
  if (inScope.length === 0) throw new UsageError(noFeaturesMessage(projectId));
  if (inScope.length === 1 && inScope[0]) {
    deps.print(`Feature: ${inScope[0].title}`);
    return inScope[0].id;
  }
  if (!deps.interactive) {
    throw new UsageError('Cannot ask without a terminal. Pass --feature <id or title>.');
  }
  return deps.pickFeature(inScope);
}

const CHOSEN_BY: Record<NonNullable<HandOffView['platform']>['chosenBy'], string> = {
  ASKED: 'as asked',
  TEAM_ROLE: 'from your Team Role',
  CHANGED_FILES: 'from your Team Roles and the changed files',
  ONLY_TARGET: "the Feature's only target Platform",
};

/** What was written, in a few lines. */
export function summary(view: HandOffView, relativePath: string): string[] {
  const size = `about ${view.tokens.used.toLocaleString('en-US')} of ${view.tokens.budget.toLocaleString('en-US')} tokens`;
  const spec = view.specVersion ? `Spec v${view.specVersion}` : 'no Spec yet';
  const lines = [`Wrote ${relativePath}: "${view.title}", ${spec}, ${size}.`];
  if (view.jiraIssueKey) lines.push(`Jira Epic: ${view.jiraIssueKey}`);
  if (view.designDoc && view.platform) {
    const stale = view.designDoc.stale
      ? `; stale: Spec v${view.specVersion} changed it, and an update is on its way`
      : '';
    lines.push(
      `Design Doc: ${view.designDoc.name} v${view.designDoc.version}, follows Spec v${view.designDoc.specVersion} (${CHOSEN_BY[view.platform.chosenBy]}${stale}).`,
    );
  } else if (view.designDocNote) {
    lines.push(`Design Doc: ${view.designDocNote}`);
  }
  const others = view.platforms.filter((pl) => pl.key !== view.platform?.key).map((pl) => pl.name);
  if (others.length) lines.push(`Another Platform's Design Doc: --platform ${others.join(' | ')}`);
  return lines;
}

/**
 * `vorasaan run` (REQUIREMENT 15, ticket 0079): writes the Feature's Hand-off, its distilled
 * context assembled by the server, to `.vorasaan/specs/<feature>.md`, and hands it to the
 * coding assistant (`--ai`): started in the repository when it is on PATH and a person is at
 * the terminal, else the command to start it is printed. The Platform's Design Doc is picked
 * by the server from the user's Team Roles and the changed files' Platform hint (only names
 * are sent, never a file), or by `--platform`. The CLI's credentials never reach the file, the
 * command line or the assistant's environment.
 */
export async function runRun(options: RunOptions, deps: RunDeps): Promise<RunResult> {
  const featureId = await resolveFeature(options, deps);
  if (!featureId) {
    deps.print('Cancelled. Nothing was written.');
    return { exitCode: 0, launched: false };
  }
  const { root } = deps.repo;

  // Which target Platforms the changed files point to: names only, best first.
  let hint: string[] = [];
  if (!options.platform) {
    const [feature, files] = await Promise.all([
      deps.api.feature(featureId),
      (deps.changedFiles ?? changedFiles)(root).catch(() => [] as string[]),
    ]);
    hint = suggestPlatforms(files, feature.platforms)
      .filter((s) => s.known)
      .map((s) => s.name);
  }

  const view = await deps.api.handOff(featureId, {
    ...(options.platform ? { platform: options.platform } : {}),
    ...(hint.length ? { hint } : {}),
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
  });
  const markdown = redactCredentials(view.markdown);
  if (deps.secrets.some((secret) => secret.length >= 8 && markdown.includes(secret))) {
    throw new UsageError(
      'The Hand-off contains your Vorasaan access token; nothing was written. Revoke the token in the web app.',
    );
  }
  const written = await writeHandOff(root, view.slug, view.featureId, markdown);
  for (const line of summary(view, written.relativePath)) deps.print(line);
  if ((await gitIgnores(root, written.relativePath)) === false) {
    deps.print(
      `Tip: add "${HAND_OFF_RELATIVE_DIR}/" to .gitignore. A Hand-off is a snapshot: run \`vorasaan run\` again for the latest.`,
    );
  }

  const prompt = handOffPrompt(written.relativePath);
  const base = { path: written.path, view };
  if (!options.ai) {
    deps.print(
      `Hand it to your coding assistant, for example: ${assistantCommand('claude', prompt)}`,
    );
    return { ...base, exitCode: 0, launched: false };
  }
  const command = assistantCommand(options.ai, prompt);
  if (!options.launch || !deps.interactive) {
    deps.print(`Start ${options.ai} with: ${command}`);
    return { ...base, exitCode: 0, launched: false };
  }
  const assistant = ASSISTANTS[options.ai];
  const bin = deps.which(assistant.bin);
  if (!bin) {
    deps.print(`${assistant.bin} isn't on your PATH. Install it, then run: ${command}`);
    return { ...base, exitCode: 0, launched: false };
  }
  deps.print(`Starting ${options.ai} in ${root}…`);
  const exitCode = await deps.spawn([bin, ...assistant.args(prompt)], {
    cwd: root,
    env: assistantEnv(deps.env),
  });
  return { ...base, exitCode, launched: true };
}

/** The interactive Feature picker (clack). */
export async function pickFeatureInTerminal(
  features: FeatureSummaryView[],
): Promise<string | undefined> {
  const choice = await p.select<string>({
    message: 'Which Feature are you working on?',
    options: features.map((f) => ({
      value: f.id,
      label: f.title,
      hint: `${f.projectName} / ${f.teamName} · ${f.myRoles.join(', ')}`,
    })),
  });
  return p.isCancel(choice) ? undefined : choice;
}

/** Runs the assistant with the terminal handed over; resolves with its exit code. */
export async function spawnInTerminal(
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): Promise<number> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exited;
}
