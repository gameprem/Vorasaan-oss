import { describe, expect, test } from 'bun:test';
import type { RaiseOptions } from './commands/raise-options.ts';
import type { ScanOptions } from './commands/scan.ts';
import { ConfigError } from './config.ts';
import { buildProgram } from './program.ts';

const emptyConfigDir = `${import.meta.dir}/.test-config-${process.pid}`;
const env = {
  VORASAAN_USER: 'user-1',
  VORASAAN_API_URL: 'http://api.test',
  XDG_CONFIG_HOME: emptyConfigDir,
};

let scanned: ScanOptions | undefined;

async function run(args: string[], runEnv: Record<string, string | undefined> = env) {
  let received: RaiseOptions | undefined;
  scanned = undefined;
  const program = buildProgram(
    {
      raise: async (_api, options) => {
        received = options;
      },
      login: async () => {},
      logout: async () => {},
      whoami: async () => {},
      scan: async (options) => {
        scanned = options;
      },
    },
    runEnv,
  ).exitOverride();
  await program.parseAsync(['bun', 'vorasaan', ...args]);
  return received;
}

describe('vorasaan raise argument parsing', () => {
  test('passes flags through to the action', async () => {
    expect(
      await run([
        'raise',
        '--feature',
        'f-1',
        '-k',
        'blocker',
        '-t',
        'Slow API',
        '-d',
        'Takes 8s',
        '-r',
        'po',
        '--yes',
      ]),
    ).toEqual({
      featureId: 'f-1',
      kind: 'BLOCKER',
      title: 'Slow API',
      description: 'Takes 8s',
      deciderRole: 'PO',
      withChoices: true,
      yes: true,
    });
  });

  test('--no-choices', async () => {
    expect((await run(['raise', '-k', 'question', '--no-choices']))?.withChoices).toBe(false);
  });

  test('fails with a readable error when not signed in', async () => {
    await expect(run(['raise'], { XDG_CONFIG_HOME: emptyConfigDir })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe('vorasaan scan argument parsing', () => {
  const project = '00000000-0000-4000-8000-000000000201';

  test('asks by default: neither --dry-run nor --yes is implied', async () => {
    await run(['scan', '--project', project]);
    expect(scanned).toEqual({ projectId: project, dir: process.cwd(), dryRun: false, yes: false });
  });

  test('--dry-run, --yes and --dir', async () => {
    await run(['scan', '-p', project, '--dir', '/tmp/repo', '--dry-run', '-y']);
    expect(scanned).toEqual({ projectId: project, dir: '/tmp/repo', dryRun: true, yes: true });
  });

  test('needs a Project id', async () => {
    await expect(run(['scan', '--project', 'not-an-id'])).rejects.toThrow('--project');
  });
});
