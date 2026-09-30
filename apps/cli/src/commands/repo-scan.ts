import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, sep } from 'node:path';

/**
 * Builds a Repo Scan: a Markdown summary of a codebase (READMEs, dependency
 * manifests, module names, routes and entry points), never whole source files.
 *
 * - The file list comes from `git ls-files` in a git repository (so
 *   `.gitignore` applies), else from a directory walk; both skip IGNORED_DIRS,
 *   secret-looking files (SECRET_FILE) and symlinks.
 * - Only these are copied as text: README files (redacted, capped) and names
 *   extracted from manifests. Source files are read only to match single-line
 *   route patterns; only the route path and the file's path are kept.
 * - Every line that looks like a credential is redacted, and the whole summary
 *   is capped at `maxBytes`, listing what was cut.
 */

export const SCAN_MAX_BYTES = 200_000;

export type RepoScan = {
  markdown: string;
  repoName: string;
  commitSha?: string;
  /** What was cut to fit the caps, also listed at the end of the Markdown. */
  truncated: string[];
  /** How many files were considered (after ignore rules). */
  fileCount: number;
};

export type ScanLimits = { maxBytes?: number };

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.gradle',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.terraform',
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
]);

/** Files that may hold credentials: never listed, never read. */
const SECRET_FILE = [
  /^\.env($|\.)/i,
  /^\.envrc$/i,
  /\.env$/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|crt|cer|der|csr|asc|gpg|pgp|ppk|kdbx|ovpn|tfvars|tfstate)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|git-credentials|htpasswd|pgpass|dockercfg)$/i,
  /^(credentials|secrets?)(\.|$)/i,
  /secret/i,
  /service[-_]?account.*\.json$/i,
];

const TREE_DEPTH = 3;
const TREE_ENTRIES_PER_DIR = 40;
const MANIFEST_DIR_DEPTH = 2;
const README_MAX_BYTES = 8_000;
const MAX_FILES = 20_000;
const MAX_SOURCE_FILES = 3_000;
const MAX_SOURCE_BYTES = 256_000;
const MAX_MANIFEST_BYTES = 256_000;
const MAX_DEPS_PER_MANIFEST = 150;
const MAX_ROUTES = 300;
const SECTION_CAPS = { dependencies: 30_000, routes: 30_000, modules: 60_000, readmes: 80_000 };

const REDACTED = '[redacted: looks like a secret]';
const SECRET_LINE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/,
  /\bvsp_[A-Za-z0-9_-]{8,}/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /[A-Za-z0-9_]*(secret|token|passw(or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^\s"']{6,}/i,
  /\b[A-Z0-9_]*KEY\s*=\s*\S+/,
];

/** Replaces every line that looks like it holds a credential. */
export function redactSecrets(text: string): string {
  return text
    .split('\n')
    .map((line) => (SECRET_LINE.some((re) => re.test(line)) ? REDACTED : line))
    .join('\n');
}

export async function collectRepoScan(dir: string, limits: ScanLimits = {}): Promise<RepoScan> {
  const maxBytes = limits.maxBytes ?? SCAN_MAX_BYTES;
  const root = await realpath(dir);
  const truncated: string[] = [];
  const inGit = (await git(root, 'rev-parse', '--is-inside-work-tree')) === 'true';

  const listed = inGit ? await gitFiles(root) : await walk(root);
  let files = [...new Set(listed)].filter(isScannable).sort();
  files = await withoutSymlinks(root, files);
  if (files.length > MAX_FILES) {
    truncated.push(`Files (only the first ${MAX_FILES} of ${files.length} were considered)`);
    files = files.slice(0, MAX_FILES);
  }

  const commitSha = inGit ? await git(root, 'rev-parse', 'HEAD') : undefined;
  const repoName =
    (inGit && remoteName(await git(root, 'config', '--get', 'remote.origin.url'))) ||
    basename(root).slice(0, 200);

  const manifests = await readManifests(root, files);
  const sections: Section[] = [
    { title: 'Dependencies', cap: SECTION_CAPS.dependencies, body: manifests.lines.join('\n') },
    {
      title: 'Routes and entry points',
      cap: SECTION_CAPS.routes,
      body: await routesAndEntryPoints(root, files, manifests.entryPoints, truncated),
    },
    { title: 'Modules', cap: SECTION_CAPS.modules, body: tree(files, truncated) },
    { title: 'READMEs', cap: SECTION_CAPS.readmes, body: await readmes(root, files, truncated) },
  ];

  const header = [
    `# Repo Scan: ${repoName}`,
    '',
    ...(commitSha && /^[0-9a-f]{7,64}$/.test(commitSha) ? [`Commit: ${commitSha}`, ''] : []),
    'A summary made by `vorasaan scan`: READMEs, dependency manifests, module names, routes and entry points. It never contains whole source files.',
  ].join('\n');

  const markdown = assemble(header, sections, maxBytes, truncated);
  return {
    markdown,
    repoName,
    commitSha: commitSha && /^[0-9a-f]{7,64}$/.test(commitSha) ? commitSha : undefined,
    truncated,
    fileCount: files.length,
  };
}

// ─── File list ─────────────────────────────────────────────────────────────

/** Runs git read-only in `cwd`, with repository hooks such as fsmonitor turned off. */
async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', '-c', 'core.fsmonitor=false', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : undefined;
  } catch {
    return undefined; // git is not installed
  }
}

/** Tracked and untracked-but-not-ignored files, relative to `root`. */
async function gitFiles(root: string): Promise<string[]> {
  const out = await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  return (out ?? '').split('\0').filter(Boolean);
}

/** Every file under `root`, not following symlinks and skipping IGNORED_DIRS. */
async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(rel: string, depth: number) {
    if (depth > 12 || files.length > MAX_FILES) return;
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(path, depth + 1);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await visit('', 0);
  return files;
}

function isScannable(path: string): boolean {
  if (!isSafeRelative(path)) return false;
  const segments = path.split('/');
  if (segments.slice(0, -1).some((s) => IGNORED_DIRS.has(s) || isSecretName(s))) return false;
  return !isSecretName(segments.at(-1) ?? '');
}

function isSecretName(name: string): boolean {
  return SECRET_FILE.some((re) => re.test(name));
}

function isSafeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.split('/').some((s) => s === '..' || s === '.' || s === '')
  );
}

async function withoutSymlinks(root: string, files: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const file of files) {
    const stat = await lstat(join(root, file)).catch(() => null);
    if (stat?.isFile()) kept.push(file);
  }
  return kept;
}

/** Reads up to `maxBytes` of a regular file that really lives inside `root`. */
async function readInside(root: string, rel: string, maxBytes: number): Promise<string | null> {
  if (!isSafeRelative(rel)) return null;
  const path = join(root, rel);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return null;
    const real = await realpath(path);
    if (!real.startsWith(root + sep)) return null;
    return await Bun.file(real).slice(0, maxBytes).text();
  } catch {
    return null;
  }
}

/** "owner/repo" from a remote URL, dropping any credentials in it. */
function remoteName(url: string | undefined): string | undefined {
  const match = url?.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

const depthOf = (path: string) => path.split('/').length - 1;

// ─── Manifests ─────────────────────────────────────────────────────────────

const SAFE_NAME = /^[@\w][\w@./:+-]{0,199}$/;

type Manifests = { lines: string[]; entryPoints: { path: string; label: string }[] };

async function readManifests(root: string, files: string[]): Promise<Manifests> {
  const lines: string[] = [];
  const entryPoints: Manifests['entryPoints'] = [];
  const fileSet = new Set(files);
  for (const file of files) {
    if (depthOf(file) > MANIFEST_DIR_DEPTH) continue;
    const parse = MANIFEST_PARSERS[basename(file)];
    if (!parse) continue;
    const text = await readInside(root, file, MAX_MANIFEST_BYTES);
    if (text === null) continue;
    const parsed = parse(text);
    if (!parsed) continue;
    const parts = [
      parsed.name && SAFE_NAME.test(parsed.name) ? parsed.name : undefined,
      ...Object.entries(parsed.deps ?? {})
        .map(([label, names]) => [label, names.filter((n) => SAFE_NAME.test(n))] as const)
        .filter(([, names]) => names.length > 0)
        .map(([label, names]) => `${label ? `${label}: ` : ''}${capList(names)}`),
    ].filter(Boolean);
    if (parts.length) lines.push(`- \`${file}\`: ${parts.join('; ')}`);
    for (const entry of parsed.entries ?? []) {
      const path = posix.normalize(posix.join(dirname(file) === '.' ? '' : dirname(file), entry));
      if (fileSet.has(path)) {
        entryPoints.push({ path, label: `main of ${parsed.name ?? file}` });
      }
    }
  }
  return { lines, entryPoints };
}

function capList(names: string[]): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, MAX_DEPS_PER_MANIFEST).join(', ');
  return unique.length > MAX_DEPS_PER_MANIFEST
    ? `${shown} (+${unique.length - MAX_DEPS_PER_MANIFEST} more)`
    : shown;
}

type Parsed = { name?: string; deps?: Record<string, string[]>; entries?: string[] };

const firstMatch = (text: string, re: RegExp) => text.match(re)?.[1];
const allMatches = (text: string, re: RegExp, group = 1) =>
  [...text.matchAll(re)].map((m) => m[group] ?? '').filter(Boolean);
const pyName = (spec: string) => spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9_.-]*/)?.[0];

/** The lines of a TOML table, up to the next table header. */
function tomlTable(text: string, name: string): string {
  const start = text.search(new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^\s*\[/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}
const tomlKeys = (table: string) => allMatches(table, /^\s*([A-Za-z0-9_.-]+)\s*=/gm);

const MANIFEST_PARSERS: Record<string, (text: string) => Parsed | null> = {
  'package.json': (text) => {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
    const entries = [
      ...(typeof json.main === 'string' ? [json.main] : []),
      ...(typeof json.bin === 'string'
        ? [json.bin]
        : Object.values((json.bin as object) ?? {}).filter((v) => typeof v === 'string')),
    ];
    return {
      name: typeof json.name === 'string' ? json.name : undefined,
      deps: {
        dependencies: keys(json.dependencies),
        'dev dependencies': keys(json.devDependencies),
        'peer dependencies': keys(json.peerDependencies),
      },
      entries,
    };
  },
  'go.mod': (text) => {
    const block = firstMatch(text, /^require\s*\(([\s\S]*?)^\)/m) ?? '';
    return {
      name: firstMatch(text, /^module\s+(\S+)/m),
      deps: {
        requires: [
          ...allMatches(block, /^\s*(\S+)\s+v\S*/gm),
          ...allMatches(text, /^require\s+(\S+)\s+v\S*/gm),
        ],
      },
    };
  },
  'pyproject.toml': (text) => {
    const project = tomlTable(text, 'project');
    const poetry = tomlTable(text, 'tool.poetry');
    const list = firstMatch(project, /^dependencies\s*=\s*\[([\s\S]*?)\]/m) ?? '';
    return {
      name:
        firstMatch(project, /^name\s*=\s*["']([^"']+)["']/m) ??
        firstMatch(poetry, /^name\s*=\s*["']([^"']+)["']/m),
      deps: {
        dependencies: [
          ...allMatches(list, /["']([^"']+)["']/g).map(pyName),
          ...tomlKeys(tomlTable(text, 'tool.poetry.dependencies')).filter((k) => k !== 'python'),
        ].filter((n): n is string => !!n),
      },
    };
  },
  'requirements.txt': (text) => ({
    deps: {
      '': text
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter((l) => l && !l.startsWith('-') && !l.includes('://'))
        .map(pyName)
        .filter((n): n is string => !!n),
    },
  }),
  Gemfile: (text) => ({ deps: { gems: allMatches(text, /^\s*gem\s+['"]([^'"]+)['"]/gm) } }),
  'Cargo.toml': (text) => ({
    name: firstMatch(tomlTable(text, 'package'), /^name\s*=\s*["']([^"']+)["']/m),
    deps: {
      dependencies: tomlKeys(tomlTable(text, 'dependencies')),
      'dev dependencies': tomlKeys(tomlTable(text, 'dev-dependencies')),
    },
  }),
  'pom.xml': (text) => {
    const own = text
      .replace(/<parent>[\s\S]*?<\/parent>/g, '')
      .replace(/<dependencies>[\s\S]*<\/dependencies>/g, '');
    const deps = [...text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map((m) => {
      const group = firstMatch(m[1] ?? '', /<groupId>\s*([^<\s]+)\s*<\/groupId>/);
      const artifact = firstMatch(m[1] ?? '', /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
      return group && artifact ? `${group}:${artifact}` : (artifact ?? '');
    });
    return {
      name: firstMatch(own, /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/),
      deps: { dependencies: deps },
    };
  },
  ...Object.fromEntries(
    ['build.gradle', 'build.gradle.kts'].map((file) => [
      file,
      (text: string): Parsed => ({
        deps: {
          dependencies: [
            ...text.matchAll(
              /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|ksp|annotationProcessor)\s*\(?\s*['"]([\w.-]+):([\w.-]+)(?::[^'"]*)?['"]/g,
            ),
          ].map((m) => `${m[1]}:${m[2]}`),
        },
      }),
    ]),
  ),
};

// ─── Routes and entry points ───────────────────────────────────────────────

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb)$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e|fixtures?)\/|[._](test|spec)\.[a-z]+$/;
const SAFE_ROUTE = /^[\w\-./:{}[\]*$@~()+]{0,200}$/;
const NEXT_APP = /(?:^|\/)app\/((?:[^/]+\/)*)(page|route)\.(tsx|ts|jsx|js|mdx)$/;
const NEXT_PAGES = /(?:^|\/)pages\/((?:[^/]+\/)*)([^/]+)\.(tsx|ts|jsx|js|mdx)$/;
const CALL_ROUTE =
  /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|all|route|Get|Post|Put|Patch|Delete|GET|POST|PUT|PATCH|DELETE|HandleFunc|Handle)\(\s*(['"`])(\/[^'"`\s]*)\2/g;
const NEST_CONTROLLER = /@Controller\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)/;
const NEST_METHOD = /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g;
const RAILS_ROUTE =
  /^\s*(resources?|get|post|put|patch|delete|root|namespace|scope)\s+['":]?([\w/:.-]+)/gm;
const ENTRY_NAMES = new Set([
  'main.go',
  'main.py',
  '__main__.py',
  'manage.py',
  'app.py',
  'wsgi.py',
  'asgi.py',
  'main.rs',
  'main.ts',
  'main.js',
  'server.ts',
  'server.js',
]);

function nextRoute(dirs: string): string {
  const segments = dirs
    .split('/')
    .filter(Boolean)
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  return `/${segments.join('/')}`;
}

const joinRoute = (...parts: string[]) =>
  `/${parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/')}`;

async function routesAndEntryPoints(
  root: string,
  files: string[],
  mains: Manifests['entryPoints'],
  truncated: string[],
): Promise<string> {
  const routes: string[] = [];
  const add = (route: string, file: string) => {
    const words = route.split(' ');
    const path = words.pop() ?? '';
    if (SAFE_ROUTE.test(path) && words.every((w) => /^[A-Za-z]{1,10}$/.test(w))) {
      routes.push(`- \`${route}\` (${file})`);
    }
  };

  let read = 0;
  for (const file of files) {
    if (TEST_FILE.test(file)) continue;
    const app = file.match(NEXT_APP);
    if (app) {
      add(app[2] === 'route' ? `API ${nextRoute(app[1] ?? '')}` : nextRoute(app[1] ?? ''), file);
      continue;
    }
    const pages = file.match(NEXT_PAGES);
    if (pages && !pages[2]?.startsWith('_')) {
      const route = nextRoute(`${pages[1] ?? ''}${pages[2] === 'index' ? '' : pages[2]}`);
      add(route.startsWith('/api') ? `API ${route}` : route, file);
      continue;
    }
    const isRails = file.endsWith('config/routes.rb');
    if (!SOURCE.test(file) || read >= MAX_SOURCE_FILES) continue;
    read++;
    const text = await readInside(root, file, MAX_SOURCE_BYTES);
    if (!text) continue;
    if (isRails) {
      for (const m of text.matchAll(RAILS_ROUTE)) add(`${m[1]} ${m[2]}`, file);
      continue;
    }
    const controller = text.match(NEST_CONTROLLER);
    if (controller) {
      for (const m of text.matchAll(NEST_METHOD)) {
        add(
          `${(m[1] ?? '').toUpperCase().replace('ALL', 'ANY')} ${joinRoute(controller[2] ?? '', m[3] ?? '')}`,
          file,
        );
      }
    }
    for (const m of text.matchAll(CALL_ROUTE)) {
      const method = (m[1] ?? '').toUpperCase();
      const verb = ['ROUTE', 'ALL', 'HANDLEFUNC', 'HANDLE'].includes(method) ? 'ANY' : method;
      add(`${verb} ${m[3]}`, file);
    }
  }
  if (read >= MAX_SOURCE_FILES)
    truncated.push(`Routes (only ${MAX_SOURCE_FILES} source files were checked)`);

  const unique = [...new Set(routes)];
  if (unique.length > MAX_ROUTES)
    truncated.push(`Routes (${unique.length - MAX_ROUTES} more not listed)`);

  const seen = new Set(mains.map((m) => m.path));
  const entries = [
    ...mains.map((m) => `- \`${m.path}\` (${m.label})`),
    ...files
      .filter(
        (f) =>
          ENTRY_NAMES.has(basename(f)) && !seen.has(f) && !TEST_FILE.test(f) && depthOf(f) <= 4,
      )
      .map((f) => `- \`${f}\``),
  ];

  return [
    '### Routes',
    '',
    unique.length ? unique.slice(0, MAX_ROUTES).join('\n') : '_None detected._',
    '',
    '### Entry points',
    '',
    entries.length ? [...new Set(entries)].join('\n') : '_None detected._',
  ].join('\n');
}

// ─── Module tree ───────────────────────────────────────────────────────────

type Dir = { dirs: Map<string, Dir>; files: string[] };

function tree(files: string[], truncated: string[]): string {
  const top: Dir = { dirs: new Map(), files: [] };
  for (const file of files) {
    const segments = file.split('/');
    let node = top;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push(segments.at(-1) ?? '');
  }

  const lines: string[] = [];
  let hidden = 0;
  function render(node: Dir, depth: number) {
    const entries = [
      ...[...node.dirs.keys()].sort().map((name) => ({ name, dir: node.dirs.get(name) })),
      ...node.files.sort().map((name) => ({ name, dir: undefined })),
    ];
    for (const [i, entry] of entries.entries()) {
      if (i === TREE_ENTRIES_PER_DIR) {
        const more = entries.length - TREE_ENTRIES_PER_DIR;
        hidden += more;
        lines.push(`${'  '.repeat(depth)}… and ${more} more`);
        break;
      }
      lines.push(`${'  '.repeat(depth)}${entry.name}${entry.dir ? '/' : ''}`);
      if (entry.dir && depth + 1 < TREE_DEPTH) render(entry.dir, depth + 1);
    }
  }
  render(top, 0);
  if (hidden) truncated.push(`Modules (${hidden} entries not listed)`);
  return ['```', ...lines, '```'].join('\n');
}

// ─── READMEs ───────────────────────────────────────────────────────────────

const README = /^readme(\.(md|markdown|mdx|txt|rst|adoc))?$/i;

/** READMEs at the root and at the top of packages (a directory with a manifest). */
async function readmes(root: string, files: string[], truncated: string[]): Promise<string> {
  const packageDirs = new Set(
    files
      .filter((f) => depthOf(f) <= MANIFEST_DIR_DEPTH && basename(f) in MANIFEST_PARSERS)
      .map((f) => posix.dirname(f)),
  );
  packageDirs.add('.');
  const blocks: string[] = [];
  for (const file of files) {
    if (!README.test(basename(file)) || !packageDirs.has(posix.dirname(file))) continue;
    const text = await readInside(root, file, README_MAX_BYTES * 2);
    if (text === null) continue;
    let body = text.replaceAll('\0', '').trim();
    if (Buffer.byteLength(body) > README_MAX_BYTES) {
      body = cutToBytes(body, README_MAX_BYTES);
      truncated.push(`${file} (cut at ${README_MAX_BYTES / 1000} KB)`);
    }
    blocks.push(`### ${file}\n\n${body}`);
  }
  return blocks.join('\n\n') || '_None found._';
}

// ─── Assembly and caps ─────────────────────────────────────────────────────

type Section = { title: string; cap: number; body: string };

/** Cuts text at a line boundary so it is at most `maxBytes` UTF-8 bytes. */
function cutToBytes(text: string, maxBytes: number): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > maxBytes) break;
    kept.push(line);
    size += bytes;
  }
  return kept.join('\n');
}

const TRUNCATED_RESERVE = 4_000;

function assemble(
  header: string,
  sections: Section[],
  maxBytes: number,
  truncated: string[],
): string {
  let budget = maxBytes - TRUNCATED_RESERVE - Buffer.byteLength(header) - 2;
  const parts = [header];
  for (const section of sections) {
    let body = redactSecrets(section.body);
    const cap = Math.min(section.cap, Math.max(0, budget - Buffer.byteLength(section.title) - 8));
    if (Buffer.byteLength(body) > cap) {
      body = cutToBytes(body, cap);
      // Close a fence the cut left open.
      if ((body.match(/^```/gm) ?? []).length % 2 === 1) body += '\n```';
      truncated.push(`${section.title} (cut to ${Math.round(cap / 1000)} KB)`);
    }
    const part = `## ${section.title}\n\n${body}`;
    budget -= Buffer.byteLength(part) + 2;
    parts.push(part);
  }
  if (truncated.length) {
    const list = truncated.slice(0, 50).map((t) => `- ${redactSecrets(t)}`);
    parts.push(cutToBytes(`## Truncated\n\n${list.join('\n')}`, TRUNCATED_RESERVE - 2));
  }
  return `${parts.join('\n\n')}\n`;
}
