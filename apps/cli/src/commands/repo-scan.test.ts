import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectRepoScan, redactSecrets, SCAN_MAX_BYTES } from './repo-scan.ts';

const FAKE_AWS = `AKIA${'Q'.repeat(16)}`;

/** A small monorepo: a Next.js app, a Nest server, a Go service and some things that must never leave. */
const FILES: Record<string, string> = {
  'README.md': `# Mobile Bank\n\nPay bills from your phone.\n\nSet OPENAI_API_KEY=sk-${'a'.repeat(30)} to run locally.\n`,
  'package.json': JSON.stringify({
    name: 'mobile-bank',
    private: true,
    workspaces: ['apps/*'],
    scripts: { deploy: 'TOKEN=abc123456 ./deploy.sh' },
    devDependencies: { turbo: '^2.0.0' },
  }),
  '.gitignore': 'ignored-notes.md\nlocal/\n',
  '.env': 'DATABASE_URL=postgres://u:hunter2@db/prod\n',
  '.env.production': 'STRIPE_SECRET=sk_live_x\n',
  'ignored-notes.md': 'private notes\n',
  'local/scratch.ts': "app.get('/should-not-appear', h)\n",
  'deploy/id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n',
  'deploy/server.pem': '-----BEGIN CERTIFICATE-----\n',
  'deploy/tls.key': 'key\n',
  'config/settings.ts': `export const aws = '${FAKE_AWS}';\n`,
  'apps/web/README.md': '# Web\n\nThe customer app.\n',
  'apps/web/package.json': JSON.stringify({
    name: '@bank/web',
    dependencies: { next: '16.0.0', react: '19.0.0' },
    devDependencies: { typescript: '5.9.0' },
  }),
  'apps/web/app/page.tsx': 'export default function Home() { return null; }\n',
  'apps/web/app/(shop)/bills/[id]/page.tsx': 'export default function Bill() { return null; }\n',
  'apps/web/app/api/health/route.ts': 'export function GET() {}\n',
  'apps/server/package.json': JSON.stringify({
    name: '@bank/server',
    main: 'src/main.ts',
    dependencies: { '@nestjs/core': '12.0.0', express: '5.0.0' },
  }),
  'apps/server/src/main.ts': 'bootstrap();\n',
  'apps/server/src/bills.controller.ts': [
    "@Controller('bills')",
    'export class BillsController {',
    '  @Get()',
    '  list() {}',
    "  @Post(':id/pay')",
    '  pay() { const password = "never-send-me"; }',
    '}',
  ].join('\n'),
  'apps/server/src/legacy.ts':
    "router.get('/legacy/ping', (req, res) => res.send('SECRET BODY'));\n",
  'apps/server/src/bills.controller.test.ts': "app.get('/from-a-test', h)\n",
  'services/rates/go.mod':
    'module github.com/acme/rates\n\ngo 1.23\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.0.0\n)\n',
  'services/rates/main.go': 'package main\n\nfunc main() { r.Get("/rates", h) }\n',
  'services/ml/pyproject.toml':
    '[project]\nname = "risk-model"\ndependencies = [\n  "fastapi>=0.1",\n  "numpy",\n]\n',
  'services/ml/requirements.txt':
    'fastapi==0.110\n--extra-index-url https://user:pw@pypi.acme.test/simple\nuvicorn[standard]>=0.29\n',
  'node_modules/leftpad/README.md': '# leftpad\n',
  'dist/bundle.js': "app.get('/built', h)\n",
};

async function writeFixture(root: string) {
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function git(root: string, ...args: string[]) {
  const proc = Bun.spawn(
    [
      'git',
      '-c',
      'user.email=t@t.test',
      '-c',
      'user.name=T',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  );
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return (await new Response(proc.stdout).text()).trim();
}

describe('collectRepoScan', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'vorasaan-scan-'));
    root = join(base, 'mobile-bank');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'README.md'), '# Outside the repo\n');
    await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'outside-secret-pkg' }));
    await writeFixture(root);
    // Symlinks that point outside the repository are never followed.
    await symlink(outside, join(root, 'linked'));
    await symlink(join(outside, 'README.md'), join(root, 'apps', 'web', 'README.txt'));
  });

  afterEach(() => rm(base, { recursive: true, force: true }));

  function expectNothingPrivate(markdown: string) {
    for (const leak of [
      '.env',
      'hunter2',
      'sk_live',
      'ignored-notes',
      'should-not-appear',
      'id_rsa',
      'server.pem',
      'tls.key',
      'PRIVATE KEY',
      FAKE_AWS,
      'never-send-me',
      'SECRET BODY',
      'sk-aaaa',
      'TOKEN=abc',
      'user:pw',
      'leftpad',
      '/built',
      'from-a-test',
      'Outside the repo',
      'outside-secret-pkg',
      'bootstrap()',
    ]) {
      expect(markdown).not.toContain(leak);
    }
  }

  test('a git repository: README, manifests, tree and routes; ignored and secret files never appear', async () => {
    await git(root, 'init', '-q');
    await git(
      root,
      'remote',
      'add',
      'origin',
      'https://x-token:ghp_secret@github.com/acme/mobile-bank.git',
    );
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'init');
    const sha = await git(root, 'rev-parse', 'HEAD');

    const scan = await collectRepoScan(root);
    expect(scan.repoName).toBe('acme/mobile-bank');
    expect(scan.commitSha).toBe(sha);
    expect(scan.truncated).toEqual([]);
    const md = scan.markdown;
    expectNothingPrivate(md);
    expect(md).not.toContain('ghp_secret');
    expect(md).toStartWith(`# Repo Scan: acme/mobile-bank\n\nCommit: ${sha}\n`);

    // READMEs at the root and at the top of packages, with secret-looking lines redacted.
    expect(md).toContain('### README.md\n\n# Mobile Bank\n\nPay bills from your phone.');
    expect(md).toContain('[redacted: looks like a secret]');
    expect(md).toContain('### apps/web/README.md\n\n# Web\n\nThe customer app.');

    // Manifests: names and dependency names only.
    expect(md).toContain('- `package.json`: mobile-bank; dev dependencies: turbo');
    expect(md).toContain(
      '- `apps/web/package.json`: @bank/web; dependencies: next, react; dev dependencies: typescript',
    );
    expect(md).toContain(
      '- `apps/server/package.json`: @bank/server; dependencies: @nestjs/core, express',
    );
    expect(md).toContain(
      '- `services/rates/go.mod`: github.com/acme/rates; requires: github.com/go-chi/chi/v5',
    );
    expect(md).toContain(
      '- `services/ml/pyproject.toml`: risk-model; dependencies: fastapi, numpy',
    );
    expect(md).toContain('- `services/ml/requirements.txt`: fastapi, uvicorn');
    expect(md).not.toContain('16.0.0');

    // Routes and entry points, detected from names and single lines.
    expect(md).toContain('- `/` (apps/web/app/page.tsx)');
    expect(md).toContain('- `/bills/[id]` (apps/web/app/(shop)/bills/[id]/page.tsx)');
    expect(md).toContain('- `API /api/health` (apps/web/app/api/health/route.ts)');
    expect(md).toContain('- `GET /bills` (apps/server/src/bills.controller.ts)');
    expect(md).toContain('- `POST /bills/:id/pay` (apps/server/src/bills.controller.ts)');
    expect(md).toContain('- `GET /legacy/ping` (apps/server/src/legacy.ts)');
    expect(md).toContain('- `GET /rates` (services/rates/main.go)');
    expect(md).toContain('- `apps/server/src/main.ts` (main of @bank/server)');
    expect(md).toContain('- `services/rates/main.go`');

    // The tree: names only, ignored directories left out.
    expect(md).toContain('## Modules\n\n```\napps/\n  server/\n    src/\n');
    expect(md).toContain('  web/\n    app/\n');
    expect(md).not.toContain('node_modules');
    expect(md).not.toContain('dist/');
    expect(md).not.toContain('linked');
  });

  test('outside git it walks the directory with the fixed ignore list', async () => {
    const scan = await collectRepoScan(root);
    expect(scan.repoName).toBe('mobile-bank');
    expect(scan.commitSha).toBeUndefined();
    const md = scan.markdown;
    // Without git, .gitignore is not applied, but secrets and ignored directories still are.
    for (const leak of [
      '.env',
      'hunter2',
      'id_rsa',
      'server.pem',
      'leftpad',
      '/built',
      'Outside the repo',
    ]) {
      expect(md).not.toContain(leak);
    }
    expect(md).toContain('### apps/web/README.md');
    expect(md).toContain('- `GET /bills` (apps/server/src/bills.controller.ts)');
  });

  test('the summary is size-capped and says what was cut', async () => {
    await writeFile(join(root, 'README.md'), `# Big\n\n${'Lorem ipsum dolor.\n'.repeat(5000)}`);
    for (let i = 0; i < 400; i++) {
      await writeFile(join(root, `module-${String(i).padStart(3, '0')}.ts`), '');
    }
    const scan = await collectRepoScan(root, { maxBytes: 20_000 });
    expect(Buffer.byteLength(scan.markdown)).toBeLessThanOrEqual(20_000);
    expect(scan.truncated).toContain('README.md (cut at 8 KB)');
    expect(scan.truncated.some((t) => t.startsWith('Modules'))).toBe(true);
    expect(scan.markdown).toContain('## Truncated');
    expect(scan.markdown).toContain('README.md (cut at 8 KB)');
    expect(SCAN_MAX_BYTES).toBe(200_000);
  });
});

describe('redactSecrets', () => {
  test('redacts lines that look like credentials and keeps the rest', () => {
    const text = [
      'Run bun dev',
      'API_KEY=abcdef123456',
      'password: "correct horse"',
      `aws ${FAKE_AWS}`,
      `token ghp_${'x'.repeat(36)}`,
      'git clone https://me:secret@example.test/repo',
      'The token is sent in a header.',
    ].join('\n');
    expect(redactSecrets(text).split('\n')).toEqual([
      'Run bun dev',
      '[redacted: looks like a secret]',
      '[redacted: looks like a secret]',
      '[redacted: looks like a secret]',
      '[redacted: looks like a secret]',
      '[redacted: looks like a secret]',
      'The token is sent in a header.',
    ]);
  });
});
