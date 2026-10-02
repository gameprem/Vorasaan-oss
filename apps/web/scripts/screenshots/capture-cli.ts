// The CLI screenshots: the real `vorasaan` CLI, signed in with real access tokens, run
// in a pseudo-terminal (Bun's) whose output feeds a headless xterm; what the terminal
// shows is then rendered as SVG.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import xterm from '@xterm/headless';
import type { ScriptedModel } from './model';
import { CLI_RAISE, type PersonKey } from './story';
import { terminalSvg } from './terminal-svg';

type Options = {
  root: string;
  apiUrl: string;
  outDir: string;
  model: ScriptedModel;
  projectId: string;
  /** A new access token for the person, as Settings → Access tokens makes one. */
  token: (who: PersonKey) => Promise<string>;
};

type Session = {
  term: xterm.Terminal;
  /** Waits until the screen shows `text`. */
  waitFor: (text: string, seconds?: number) => Promise<void>;
  type: (keys: string) => Promise<void>;
  exited: Promise<number>;
  kill: () => void;
};

const KEY = { enter: '\r', down: '\x1b[B' };

/** The screen as plain text, to wait on. */
function screenText(term: xterm.Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++)
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
  return lines.join('\n');
}

function session(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  cols: number,
  rows: number,
): Session {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        term.write(data);
      },
    },
  });
  const waitFor = async (text: string, seconds = 30) => {
    for (let i = 0; i < seconds * 10; i++) {
      if (screenText(term).includes(text)) return;
      await Bun.sleep(100);
    }
    throw new Error(`The CLI never showed "${text}". It showed:\n${screenText(term)}`);
  };
  return {
    term,
    waitFor,
    type: async (keys) => {
      proc.terminal?.write(keys);
      await Bun.sleep(250);
    },
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

async function run(cmd: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (${code}):\n${out}\n${err}`);
}

/** Lets the terminal finish drawing (xterm parses its input asynchronously). */
const drawn = (term: xterm.Terminal) =>
  new Promise<void>((resolve) => term.write('', () => setTimeout(resolve, 150)));

export async function captureCli(options: Options): Promise<{ name: string; bytes: number }[]> {
  const { root, apiUrl, outDir, projectId } = options;
  const home = await mkdtemp(join(tmpdir(), 'vorasaan-screens-cli-'));
  const cli = ['bun', join(root, 'apps/cli/src/index.ts')];
  const shots: { name: string; bytes: number }[] = [];
  const save = async (name: string, svg: string) => {
    await Bun.write(join(outDir, name), svg);
    shots.push({ name, bytes: Buffer.byteLength(svg) });
    console.log(`  ✓ ${name} (${Math.round(Buffer.byteLength(svg) / 1024)} KB)`);
  };

  /** Signs `who` in with `vorasaan login` and binds a repository with `vorasaan init`. */
  const workspace = async (who: PersonKey) => {
    const dir = join(home, who);
    const repo = join(dir, 'mobile-banking-app');
    await mkdir(repo, { recursive: true });
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, '.config'),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
    };
    const token = await options.token(who);
    await run([...cli, 'login', '--url', apiUrl, '--token', token], repo, env);
    await run([...cli, 'init', '--project', projectId, '--yes'], repo, env);
    return { repo, env };
  };

  try {
    // The TUI, as Oak (Tech Lead): his Inbox.
    {
      const { repo, env } = await workspace('oak');
      const tui = session([...cli, '--no-notify'], repo, env, 104, 40);
      try {
        await tui.waitFor('idempotency key');
        await tui.waitFor('live');
        await Bun.sleep(500);
        await drawn(tui.term);
        await save('cli-tui.svg', terminalSvg(tui.term, 'vorasaan', 14));
        // Open the Blocker: its Choices, and the keys to decide, Claim or ask for info.
        await tui.type(KEY.down);
        await tui.type(KEY.enter);
        await tui.waitFor('double payments');
        await Bun.sleep(500);
        await drawn(tui.term);
        await save('cli-tui-request.svg', terminalSvg(tui.term, 'vorasaan'));
      } finally {
        tui.kill();
        await tui.exited;
      }
    }

    // `vorasaan raise`, as Beam (Backend): a Question with AI-drafted Choices, sent to the PO.
    {
      const { repo, env } = await workspace('beam');
      const raise = session([...cli, 'raise'], repo, env, 104, 60);
      try {
        await raise.waitFor('Which Feature?');
        await raise.type(KEY.enter);
        await raise.waitFor('What kind of Decision Request?');
        await raise.type(KEY.down + KEY.enter);
        await raise.waitFor('Title');
        await raise.type(CLI_RAISE.title);
        await raise.type(KEY.enter);
        await raise.waitFor('Describe it');
        await raise.type(CLI_RAISE.description);
        await raise.type(KEY.enter);
        await raise.waitFor('Send to the');
        await raise.type(KEY.enter);
        await raise.exited;
        await drawn(raise.term);
        await save('cli-raise.svg', terminalSvg(raise.term, 'vorasaan raise'));
      } finally {
        raise.kill();
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  return shots;
}
