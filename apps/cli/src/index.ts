#!/usr/bin/env bun
import { ApiError } from './api.ts';
import { pickProjectInTerminal, runInit } from './commands/init.ts';
import { runLogin, runLogout, runWhoami } from './commands/login.ts';
import { runRaise } from './commands/raise.ts';
import { UsageError } from './commands/raise-options.ts';
import { confirmInTerminal, runScan } from './commands/scan.ts';
import { ConfigError } from './config.ts';
import { buildProgram } from './program.ts';
import { currentRepo } from './repo.ts';

try {
  await buildProgram({
    raise: async (api, options) => {
      const repo = await currentRepo(process.cwd(), api.baseUrl);
      if (repo.notice) console.error(repo.notice);
      await runRaise(api, options, repo);
    },
    login: (options) => runLogin(options),
    logout: () => runLogout(),
    whoami: () => runWhoami(),
    scan: (options, api) =>
      runScan(options, { api, confirm: confirmInTerminal, print: (text) => console.log(text) }),
    init: (options, api) =>
      runInit(options, {
        api,
        pickProject: pickProjectInTerminal,
        confirm: confirmInTerminal,
        print: (text) => console.log(text),
      }),
    tui: async (api) => {
      // Loaded lazily so the scriptable subcommands never pay for React and Ink.
      const { runTui } = await import('./tui/run.tsx');
      await runTui(api, await currentRepo(process.cwd(), api.baseUrl));
    },
  }).parseAsync(process.argv);
} catch (error) {
  // Expected failures get one readable line, not a stack trace.
  if (error instanceof ApiError || error instanceof UsageError || error instanceof ConfigError) {
    console.error(`\n✖ ${error.message}`);
    process.exit(1);
  }
  throw error;
}
