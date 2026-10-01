import { describe, expect, test } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import { cleanText, createNotifier, notifyCommand } from './notify.ts';

const EVIL = 'Decide "$(rm -rf ~)"; `reboot` & <b>x</b>';

describe('notifyCommand', () => {
  test('macOS: osascript reads the text from argv, never from the script', () => {
    const cmd = notifyCommand('darwin', 'Vorasaan', EVIL);
    expect(cmd?.command).toBe('osascript');
    expect(cmd?.args.slice(0, 6)).toEqual([
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e',
      'end run',
    ]);
    expect(cmd?.args.slice(6)).toEqual(['Vorasaan', EVIL]);
    // A leading dash cannot be read as an osascript option.
    expect(notifyCommand('darwin', '-x', '--help')?.args.slice(6)).toEqual([' -x', ' --help']);
  });

  test('Linux: notify-send with "--" before the text, markup escaped', () => {
    expect(notifyCommand('linux', '-t 0 Vorasaan', EVIL)).toEqual({
      command: 'notify-send',
      args: [
        '--app-name=Vorasaan',
        '--',
        '-t 0 Vorasaan',
        'Decide "$(rm -rf ~)"; `reboot` &amp; &lt;b&gt;x&lt;/b&gt;',
      ],
    });
  });

  test('Windows: a fixed PowerShell script, the text only in environment variables', () => {
    const cmd = notifyCommand('win32', 'Vorasaan', EVIL);
    expect(cmd?.command).toBe('powershell.exe');
    expect(cmd?.args.join(' ')).not.toContain('rm -rf');
    expect(cmd?.args.at(-1)).toContain('$env:VORASAAN_NOTIFY_BODY');
    expect(cmd?.args.at(-1)).toContain('SecurityElement]::Escape');
    expect(cmd?.env).toEqual({ VORASAAN_NOTIFY_TITLE: 'Vorasaan', VORASAAN_NOTIFY_BODY: EVIL });
  });

  test('no command on other platforms', () => {
    expect(notifyCommand('aix', 'a', 'b')).toBeUndefined();
  });

  test('cleanText flattens control characters and bounds the length', () => {
    expect(cleanText('a\nb\u001B[31mc\td', 100)).toBe('a b [31mc d');
    expect(cleanText('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

type Spawned = { command: string; args: string[]; options: SpawnOptions };

function fakeSpawn(fail?: Error) {
  const spawned: Spawned[] = [];
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    spawned.push({ command, args, options });
    let onError: ((e: Error) => void) | undefined;
    if (fail) queueMicrotask(() => onError?.(fail));
    return {
      on(_event: 'error', listener: (e: Error) => void) {
        onError = listener;
      },
      unref() {},
    };
  };
  return { spawn, spawned };
}

describe('createNotifier', () => {
  test('spawns the command without a shell and with output ignored', () => {
    const { spawn, spawned } = fakeSpawn();
    const notifier = createNotifier({ platform: 'linux', isTTY: true, spawn, env: {} });
    notifier.notify('Vorasaan', 'Decided: Which retry policy?');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe('notify-send');
    expect(spawned[0]?.args.slice(-2)).toEqual(['Vorasaan', 'Decided: Which retry policy?']);
    expect(spawned[0]?.options.shell).toBe(false);
    expect(spawned[0]?.options.stdio).toBe('ignore');
    expect(notifier.disabledReason).toBeUndefined();
  });

  test('a missing notifier turns notifications off quietly, never throws', async () => {
    const { spawn, spawned } = fakeSpawn(
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    );
    const notifier = createNotifier({ platform: 'linux', isTTY: true, spawn, env: {} });
    notifier.notify('a', 'b');
    await Bun.sleep(1);
    expect(notifier.disabledReason).toBe('notify-send is not available: OS notifications are off');
    notifier.notify('c', 'd');
    expect(spawned).toHaveLength(1);

    const throwing = createNotifier({
      platform: 'linux',
      isTTY: true,
      spawn: () => {
        throw new Error('EPERM');
      },
    });
    expect(() => throwing.notify('a', 'b')).not.toThrow();
    expect(throwing.disabledReason).toContain('not available');
  });

  test('--no-notify, no TTY or an unknown platform: nothing is spawned', () => {
    for (const options of [
      { enabled: false, platform: 'linux' as const, isTTY: true },
      { platform: 'linux' as const, isTTY: false },
      { platform: 'aix' as const, isTTY: true },
    ]) {
      const { spawn, spawned } = fakeSpawn();
      const notifier = createNotifier({ ...options, spawn });
      notifier.notify('a', 'b');
      expect(spawned).toEqual([]);
      expect(notifier.disabledReason).toBeString();
    }
  });

  test('Windows passes the text through the environment', () => {
    const { spawn, spawned } = fakeSpawn();
    createNotifier({ platform: 'win32', isTTY: true, spawn, env: { PATH: 'C:\\x' } }).notify(
      'T',
      'B',
    );
    expect(spawned[0]?.options.env).toEqual({
      PATH: 'C:\\x',
      VORASAAN_NOTIFY_TITLE: 'T',
      VORASAAN_NOTIFY_BODY: 'B',
    });
  });
});
