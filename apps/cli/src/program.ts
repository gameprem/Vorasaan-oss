import { Command } from 'commander';
import { VorasaanApi } from './api.ts';
import type { LoginOptions } from './commands/login.ts';
import { parseRaiseFlags, type RaiseFlags, type RaiseOptions } from './commands/raise-options.ts';
import { loadConfig } from './config.ts';

export type Actions = {
  raise: (api: VorasaanApi, options: RaiseOptions) => Promise<void>;
  login: (options: LoginOptions) => Promise<unknown>;
  logout: () => Promise<void>;
  whoami: () => Promise<unknown>;
};

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

  return program;
}
