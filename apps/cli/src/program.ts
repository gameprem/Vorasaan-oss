import { Command } from 'commander';
import { VorasaanApi } from './api.ts';
import type { InitOptions } from './commands/init.ts';
import type { LoginOptions } from './commands/login.ts';
import {
  parseRaiseFlags,
  type RaiseFlags,
  type RaiseOptions,
  UsageError,
} from './commands/raise-options.ts';
import type { ScanOptions } from './commands/scan.ts';
import { loadConfig } from './config.ts';

export type Actions = {
  raise: (api: VorasaanApi, options: RaiseOptions) => Promise<void>;
  login: (options: LoginOptions) => Promise<unknown>;
  logout: () => Promise<void>;
  whoami: () => Promise<unknown>;
  scan: (options: ScanOptions, api: () => Promise<VorasaanApi>) => Promise<unknown>;
  init: (options: InitOptions, api: () => Promise<VorasaanApi>) => Promise<unknown>;
  /** `vorasaan` with no subcommand: the long-lived TUI. */
  tui: (api: VorasaanApi, options: { notify: boolean }) => Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function signedInApi(env: Record<string, string | undefined>) {
  const config = await loadConfig(env);
  return new VorasaanApi({ baseUrl: config.apiUrl, credentials: config.credentials });
}

/** Builds the CLI; actions are injected so tests can parse arguments without prompts or network. */
export function buildProgram(actions: Actions, env = process.env): Command {
  const program = new Command()
    .name('vorasaan')
    .description('The open-source alignment engine for software teams')
    .version('0.0.0')
    .option('--no-notify', 'TUI: no OS desktop notifications (or "notify": false in the config)')
    .action(async (flags: { notify?: boolean }) => {
      const config = await loadConfig(env);
      const api = new VorasaanApi({ baseUrl: config.apiUrl, credentials: config.credentials });
      await actions.tui(api, { notify: flags.notify !== false && config.notify });
    });

  program
    .command('raise')
    .description('Raise a Blocker or Question on a Feature and get AI-drafted Choices')
    .option('-f, --feature <id>', 'Feature id (skips the picker)')
    .option('-k, --kind <kind>', 'blocker or question')
    .option('-t, --title <title>', 'short title')
    .option('-d, --description <text>', 'what you found and what is blocked')
    .option('-r, --decider-role <role>', 'po, designer, tech_lead, backend, frontend, mobile, qa')
    .option('--no-choices', 'plain-text Question without AI Choices')
    .option('-y, --yes', 'send without reviewing the Choices')
    .option('--diff', 'attach the current git diff as context (secret-looking files are skipped)')
    .option(
      '--file <path>',
      'attach a repository file as context (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(async (flags: RaiseFlags) => {
      const options = parseRaiseFlags(flags);
      await actions.raise(await signedInApi(env), options);
    });

  program
    .command('login')
    .description('Sign in with an access token created in the web app')
    .option('-u, --url <url>', 'Vorasaan server URL, e.g. http://localhost:4000')
    .option('--token <token>', 'access token (otherwise you are prompted)')
    .action(async (options: LoginOptions) => {
      await actions.login(options);
    });

  program
    .command('logout')
    .description('Forget the saved token on this machine')
    .action(() => actions.logout());

  program
    .command('whoami')
    .description('Show who the CLI is signed in as')
    .action(async () => {
      await actions.whoami();
    });

  program
    .command('scan')
    .description(
      'Send a Repo Scan (READMEs, dependencies, module names, routes; never whole source files) to a Project',
    )
    .requiredOption('-p, --project <id>', 'Project id')
    .option('--dir <path>', 'repository directory to scan', process.cwd())
    .option('--dry-run', 'print the summary and send nothing')
    .option('-y, --yes', 'send without asking for confirmation')
    .action(async (flags: { project: string; dir: string; dryRun?: boolean; yes?: boolean }) => {
      if (!UUID.test(flags.project)) {
        throw new UsageError(`--project must be a Project id, got "${flags.project}"`);
      }
      await actions.scan(
        {
          projectId: flags.project,
          dir: flags.dir,
          dryRun: flags.dryRun === true,
          yes: flags.yes === true,
        },
        () => signedInApi(env),
      );
    });

  program
    .command('init')
    .description('Bind this repository to a Project (writes .vorasaan/config.json; never a token)')
    .option('-p, --project <id>', 'Project id (skips the picker)')
    .option('-u, --url <url>', 'record the server URL of the Project in the binding')
    .option('--dir <path>', 'a directory inside the repository', process.cwd())
    .option('--scan', 'then send a Repo Scan of the repository to the Project')
    .option('--dry-run', 'with --scan: print the Repo Scan and send nothing')
    .option('-y, --yes', 'do not ask: replace an existing binding and send the Repo Scan')
    .action(
      async (flags: {
        project?: string;
        url?: string;
        dir: string;
        scan?: boolean;
        dryRun?: boolean;
        yes?: boolean;
      }) => {
        if (flags.project !== undefined && !UUID.test(flags.project)) {
          throw new UsageError(`--project must be a Project id, got "${flags.project}"`);
        }
        if (flags.url !== undefined && !URL.canParse(flags.url)) {
          throw new UsageError(`--url must be a URL, got "${flags.url}"`);
        }
        if (flags.dryRun && !flags.scan) throw new UsageError('--dry-run needs --scan');
        await actions.init(
          {
            dir: flags.dir,
            ...(flags.project ? { projectId: flags.project } : {}),
            ...(flags.url ? { apiUrl: flags.url } : {}),
            scan: flags.scan === true,
            dryRun: flags.dryRun === true,
            yes: flags.yes === true,
          },
          () => signedInApi(env),
        );
      },
    );

  return program;
}
