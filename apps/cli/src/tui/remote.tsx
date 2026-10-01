import { Text } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './format.ts';

export type Remote<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string };

/**
 * Loads once per `key` (e.g. the id being shown); a failure becomes a message. A change
 * of `refresh` (a live event, an action) reloads quietly: the shown data stays until
 * the new data arrives, so an open form is never torn down by a refresh.
 */
export function useRemote<T>(load: () => Promise<T>, key: string, refresh = ''): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ status: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;
  const lastKey = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload exactly when the key or refresh changes
  useEffect(() => {
    let live = true;
    const quiet = lastKey.current === key;
    lastKey.current = key;
    if (!quiet) setState({ status: 'loading' });
    loadRef.current().then(
      (data) => live && setState({ status: 'ok', data }),
      (error) => {
        if (!live) return;
        // A failed quiet refresh keeps what is shown.
        setState((s) =>
          quiet && s.status === 'ok' ? s : { status: 'error', message: errorMessage(error) },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [key, refresh]);
  return state;
}

export type Flash = { tone: 'ok' | 'error'; text: string };

/**
 * A one-line result message (✔ or ✖) about the data on screen (`shown`, a Remote that
 * gets a new value on every load). A ✔ outlives the reload its own action triggers,
 * and that action's echo from the server, but clears once a refresh shows the data
 * changed since: it then describes an older state.
 */
export function useFlash(
  shown: Remote<unknown>,
): [Flash | undefined, (flash: Flash | undefined) => void] {
  const [flash, setFlashState] = useState<Flash>();
  // undefined: nothing to watch · null: waiting for the action's own reload · else what that showed.
  const baseline = useRef<string | null | undefined>(undefined);
  const setFlash = useCallback((next: Flash | undefined) => {
    baseline.current = next?.tone === 'ok' ? null : undefined;
    setFlashState(next);
  }, []);
  useEffect(() => {
    if (baseline.current === undefined || shown.status !== 'ok') return;
    const now = JSON.stringify(shown.data);
    if (baseline.current === null) baseline.current = now;
    else if (now !== baseline.current) {
      baseline.current = undefined;
      setFlashState(undefined);
    }
  }, [shown]);
  return [flash, setFlash];
}

export function RemoteStatus({ state }: { state: Remote<unknown> }) {
  if (state.status === 'loading') return <Text dimColor>Loading…</Text>;
  if (state.status === 'error') {
    return <Text color="red">✖ {state.message} (R to retry)</Text>;
  }
  return null;
}
