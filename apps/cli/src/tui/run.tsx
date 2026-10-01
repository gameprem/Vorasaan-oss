import { render } from 'ink';
import { UsageError } from '../commands/raise-options.ts';
import { App, type TuiApi, type TuiRepo } from './App.tsx';
import { ErrorBoundary } from './components.tsx';

/**
 * Opens the long-lived TUI and resolves when the user quits. Ink restores the
 * terminal (raw mode, cursor, alternate screen) on unmount; we also unmount on
 * an uncaught error or a termination signal so a crash never leaves it broken.
 */
export async function runTui(api: TuiApi, repo: TuiRepo): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError(
      'The vorasaan TUI needs an interactive terminal. Use the subcommands instead (vorasaan --help).',
    );
  }
  let failure: unknown;
  const instance = render(
    <ErrorBoundary
      onError={(error) => {
        failure = error;
        instance.unmount();
      }}
    >
      <App api={api} repo={repo} />
    </ErrorBoundary>,
    { alternateScreen: true, exitOnCtrlC: true },
  );
  const crash = (error: unknown) => {
    failure = error;
    instance.unmount();
  };
  const stop = () => instance.unmount();
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    await instance.waitUntilExit();
  } finally {
    process.off('uncaughtException', crash);
    process.off('unhandledRejection', crash);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  }
  if (failure) throw failure;
}
