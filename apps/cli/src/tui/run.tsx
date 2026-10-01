import { render } from 'ink';
import type { VorasaanApi } from '../api.ts';
import { UsageError } from '../commands/raise-options.ts';
import { runEventStream } from '../events.ts';
import { createNotifier } from '../notify.ts';
import { App, type LiveFeed, type TuiApi, type TuiRepo } from './App.tsx';
import { ErrorBoundary } from './components.tsx';

/**
 * Opens the long-lived TUI and resolves when the user quits. Ink restores the
 * terminal (raw mode, cursor, alternate screen) on unmount; we also unmount on
 * an uncaught error or a termination signal so a crash never leaves it broken.
 */
export async function runTui(
  api: TuiApi & Pick<VorasaanApi, 'openEvents'>,
  repo: TuiRepo,
  options: { notify: boolean } = { notify: true },
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError(
      'The vorasaan TUI needs an interactive terminal. Use the subcommands instead (vorasaan --help).',
    );
  }
  let failure: unknown;
  // One controller for every live stream: aborted on quit, crash or signal, so the
  // process never keeps a connection (or a reconnect timer) alive after the TUI.
  const streams = new AbortController();
  // The token only ever goes to the configured server (api.openEvents), never to a
  // URL from the repository's .vorasaan/config.json.
  const live: LiveFeed = ({ onEvent, onStatus }) => {
    const own = new AbortController();
    const abort = () => own.abort();
    streams.signal.addEventListener('abort', abort, { once: true });
    runEventStream({
      open: (signal) => api.openEvents(signal),
      onEvent,
      onStatus,
      signal: own.signal,
    }).catch(() => {
      // Live updates are a convenience: never let them take the TUI down.
    });
    return () => {
      streams.signal.removeEventListener('abort', abort);
      own.abort();
    };
  };
  const notifier = createNotifier({ enabled: options.notify });
  const instance = render(
    <ErrorBoundary
      onError={(error) => {
        failure = error;
        instance.unmount();
      }}
    >
      <App api={api} repo={repo} live={live} notifier={notifier} />
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
    streams.abort();
    process.off('uncaughtException', crash);
    process.off('unhandledRejection', crash);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  }
  if (failure) throw failure;
}
