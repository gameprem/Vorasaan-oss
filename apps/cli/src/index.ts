#!/usr/bin/env bun
import { ApiError } from './api.ts';
import { runLogin, runLogout, runWhoami } from './commands/login.ts';
import { runRaise } from './commands/raise.ts';
import { UsageError } from './commands/raise-options.ts';
import { ConfigError } from './config.ts';
import { buildProgram } from './program.ts';

try {
  await buildProgram({
    raise: runRaise,
    login: (options) => runLogin(options),
    logout: () => runLogout(),
    whoami: () => runWhoami(),
  }).parseAsync(process.argv);
} catch (error) {
  // Expected failures get one readable line, not a stack trace.
  if (error instanceof ApiError || error instanceof UsageError || error instanceof ConfigError) {
    console.error(`\n✖ ${error.message}`);
    process.exit(1);
  }
  throw error;
}
