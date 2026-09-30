#!/usr/bin/env bun
import { ApiError } from './api.ts';
import { runRaise } from './commands/raise.ts';
import { UsageError } from './commands/raise-options.ts';
import { ConfigError } from './config.ts';
import { buildProgram } from './program.ts';

try {
  await buildProgram({ raise: runRaise }).parseAsync(process.argv);
} catch (error) {
  // Expected failures get one readable line, not a stack trace.
  if (error instanceof ApiError || error instanceof UsageError || error instanceof ConfigError) {
    console.error(`\n✖ ${error.message}`);
    process.exit(1);
  }
  throw error;
}
