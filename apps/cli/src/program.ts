import { Command } from 'commander';
import { VorasaanApi } from './api.ts';
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
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds the CLI; actions are injected so tests can parse arguments without prompts or network. */
export function buildProgram(actions: Actions, env = process.env): Command {
  const program = new Command()
    .name('vorasaan')
    .description('The open-source alignment engine for software teams')
    .version('0.0.0');

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
    .action(async (flags: RaiseFlags) => {
      const options = parseRaiseFlags(flags);
      const config = await loadConfig(env);
      await actions.raise(
        new VorasaanApi({ baseUrl: config.apiUrl, credentials: config.credentials }),
        options,
      );
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
        async () => {
          const config = await loadConfig(env);
          return new VorasaanApi({ baseUrl: config.apiUrl, credentials: config.credentials });
        },
      );
    });

  return program;
}
