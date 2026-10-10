import { createHash } from 'node:crypto';
import type { AgentSkillLimits, SkippedSkillFile } from '@vorasaan/shared';
import {
  isSafeRelativePath,
  readZipEntries,
  readZipEntry,
  type ZipEntry,
  ZipEntryTooLargeError,
} from './zip-reader.ts';

// An Agent Skill read from a zip (ADR 0017, ticket 0078): the open SKILL.md format, a folder
// with `SKILL.md` (frontmatter `name` and `description`) and optional `references/` and
// `assets/`. Text and templates only: scripts, binaries and links are left out and listed,
// never stored and never run. Every kept file must be UTF-8 text within the size limits.

/** The package isn't a usable Skill (no SKILL.md, bad frontmatter, several Skills...). */
export class SkillPackageError extends Error {}

/** The Skill, or one of its files, is over the size limits. */
export class SkillTooLargeError extends SkillPackageError {}

export type SkillFile = { path: string; data: Uint8Array; sha256: string };

export type SkillPackage = {
  name: string;
  description: string;
  license: string | null;
  /** SKILL.md first, then the rest by path. */
  files: SkillFile[];
  skipped: SkippedSkillFile[];
  totalBytes: number;
};

export const SKILL_FILE = 'SKILL.md';

/** Extensions of scripts and programs: never stored, never run (ADR 0017). */
const SCRIPT_EXTENSIONS = new Set(
  (
    'py pyc pyw sh bash zsh fish ksh csh js mjs cjs jsx ts mts cts tsx rb pl pm php ps1 psm1 ' +
    'bat cmd com exe dll so dylib bin jar class war go rs c cc cpp cxx h hpp java kt kts swift ' +
    'lua r vbs vb wasm applescript scpt command app msi deb rpm apk ipa elf o a lib out run ' +
    'awk sed tcl groovy scala dart ex exs erl hs ml fs fsx nim zig cs'
  ).split(' '),
);

/** Extensions kept as text (references, templates, data). Anything else is left out. */
const TEXT_EXTENSIONS = new Set(
  (
    'md markdown mdx txt text html htm svg css json jsonc yaml yml toml csv tsv xml mermaid mmd ' +
    'dot gv puml plantuml tex rst adoc asciidoc ini cfg conf tmpl tpl template j2 jinja hbs ' +
    'mustache liquid'
  ).split(' '),
);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** What happens to a file by its name alone: kept if it is text, else skipped and why. */
function classify(path: string): 'TEXT' | 'SCRIPT' | 'NOT_TEXT' {
  const ext = extensionOf(path);
  if (SCRIPT_EXTENSIONS.has(ext)) return 'SCRIPT';
  // No extension (LICENSE, NOTICE): kept only if it reads as text and isn't a "#!" script.
  if (ext === '' || TEXT_EXTENSIONS.has(ext)) return 'TEXT';
  return 'NOT_TEXT';
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The file's text, or null when it isn't UTF-8 text (NUL bytes, invalid sequences). */
export function asText(data: Uint8Array): string | null {
  try {
    const text = decoder.decode(data);
    return text.includes('\0') ? null : text.replace(/^﻿/, '');
  } catch {
    return null;
  }
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The `sha256:<hex>` a zip is pinned to. */
export function zipPin(bytes: Uint8Array): string {
  return `sha256:${sha256(bytes)}`;
}

/**
 * The folder of the archive that holds the Skill. `subpath` names it (relative to the
 * archive's single top folder, when it has one and no SKILL.md at its root, as a GitHub zip
 * has, or else to the root); without it, the root when SKILL.md is there, else the one
 * folder with a SKILL.md.
 */
function skillRoot(paths: string[], subpath: string): string {
  const files = paths.filter(Boolean);
  let base = '';
  const tops = new Set(files.map((p) => p.split('/')[0]));
  if (!files.includes(SKILL_FILE) && tops.size === 1 && files.every((p) => p.includes('/'))) {
    base = `${[...tops][0]}/`;
  }
  if (subpath) {
    // Within the single top folder (a GitHub zip's "<repo>-<sha>/"), else from the zip's root.
    const root = [`${base}${subpath}/`, `${subpath}/`].find((r) =>
      files.includes(`${r}${SKILL_FILE}`),
    );
    if (!root) throw new SkillPackageError(`There is no ${SKILL_FILE} in the folder "${subpath}"`);
    return root;
  }
  if (files.includes(`${base}${SKILL_FILE}`)) return base;
  const found = files
    .filter((p) => p.startsWith(base) && p.endsWith(`/${SKILL_FILE}`))
    .map((p) => p.slice(base.length, -SKILL_FILE.length - 1))
    .sort();
  if (found.length === 1) return `${base}${found[0]}/`;
  if (!found.length) throw new SkillPackageError(`There is no ${SKILL_FILE} in it`);
  const listed = found.slice(0, 5).join('", "');
  throw new SkillPackageError(
    `It holds several Skills ("${listed}"${found.length > 5 ? ', …' : ''}): name the folder of one`,
  );
}

/**
 * Reads the Skill in `zip` (the folder `subpath`, or the one found), checked against
 * `limits`. Throws `SkillPackageError` (or `SkillTooLargeError`) when it can't be installed.
 */
export function readSkillZip(
  zip: Uint8Array,
  options: { subpath?: string; limits: AgentSkillLimits },
): SkillPackage {
  const { limits } = options;
  if (zip.byteLength > limits.maxArchiveBytes) {
    throw new SkillTooLargeError(`The zip is larger than ${limits.maxArchiveBytes} bytes`);
  }
  const entries = readZipEntries(zip);
  const subpath = options.subpath ?? '';
  if (subpath && !isSafeRelativePath(subpath)) {
    throw new SkillPackageError('The folder must be a relative path without ".."');
  }
  const root = skillRoot(
    entries.filter((e) => !e.directory && !e.link).map((e) => e.path),
    subpath,
  );
  const inSkill = entries
    .filter((e) => !e.directory && e.path.startsWith(root))
    .map((e) => ({ entry: e, path: e.path.slice(root.length) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files: SkillFile[] = [];
  const skipped: SkippedSkillFile[] = [];
  let totalBytes = 0;
  const keep = (entry: ZipEntry, path: string) => {
    let data: Uint8Array;
    try {
      data = readZipEntry(zip, entry, limits.maxFileBytes);
    } catch (error) {
      if (error instanceof ZipEntryTooLargeError) {
        throw new SkillTooLargeError(
          `"${path}" is larger than ${limits.maxFileBytes} bytes, the most one file of a Skill may be`,
        );
      }
      throw error;
    }
    const text = asText(data);
    if (text === null) return skipped.push({ path, reason: 'NOT_TEXT' });
    if (text.startsWith('#!')) return skipped.push({ path, reason: 'SCRIPT' });
    totalBytes += data.byteLength;
    if (totalBytes > limits.maxSkillBytes) {
      throw new SkillTooLargeError(
        `The Skill's files are larger than ${limits.maxSkillBytes} bytes together`,
      );
    }
    files.push({ path, data, sha256: sha256(data) });
    if (files.length > limits.maxFiles) {
      throw new SkillTooLargeError(`The Skill has more than ${limits.maxFiles} files`);
    }
  };
  for (const { entry, path } of inSkill) {
    if (entry.link) skipped.push({ path, reason: 'LINK' });
    else if (entry.encrypted) skipped.push({ path, reason: 'NOT_TEXT' });
    else {
      const kind = classify(path);
      if (kind === 'TEXT') keep(entry, path);
      else skipped.push({ path, reason: kind });
    }
  }

  const skillMd = files.find((f) => f.path === SKILL_FILE);
  if (!skillMd) throw new SkillPackageError(`${SKILL_FILE} is not a text file`);
  const meta = skillMetadata(asText(skillMd.data) ?? '');
  return {
    ...meta,
    files: [skillMd, ...files.filter((f) => f !== skillMd)],
    skipped,
    totalBytes,
  };
}

/** The most a Skill's description may be (the open format's limit). */
export const MAX_SKILL_DESCRIPTION = 1_024;
const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

/** A SKILL.md's `name`, `description` and `license`, from its YAML frontmatter. */
export function skillMetadata(markdown: string): {
  name: string;
  description: string;
  license: string | null;
} {
  const fields = frontmatter(markdown);
  if (!fields) {
    throw new SkillPackageError(`${SKILL_FILE} has no frontmatter (a "---" block at its top)`);
  }
  const name = (fields.name ?? '').trim();
  const description = (fields.description ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new SkillPackageError(`${SKILL_FILE} has no "name" in its frontmatter`);
  if (!SKILL_NAME.test(name)) {
    throw new SkillPackageError(
      `The Skill's name "${name.slice(0, 80)}" must be one line of at most 64 letters, digits, spaces, ".", "_" or "-"`,
    );
  }
  if (!description) {
    throw new SkillPackageError(`${SKILL_FILE} has no "description" in its frontmatter`);
  }
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw new SkillPackageError(
      `The Skill's description is longer than ${MAX_SKILL_DESCRIPTION} characters`,
    );
  }
  const license = fields.license?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  return { name, description, license };
}

/**
 * The top-level string fields of a Markdown file's YAML frontmatter: `key: value`, quoted
 * values, block scalars (`|`, `>`) and plain values continued on indented lines. Nested
 * maps and lists are skipped. Null when the file has no frontmatter.
 */
export function frontmatter(markdown: string): Record<string, string> | null {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return null;
  const body = lines.slice(1, end);
  const fields: Record<string, string> = {};
  for (let i = 0; i < body.length; i++) {
    const match = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(body[i] ?? '');
    if (!match) continue;
    const key = match[1] ?? '';
    const raw = (match[2] ?? '').trim();
    const continued: string[] = [];
    while (i + 1 < body.length && /^(\s+\S|\s*$)/.test(body[i + 1] ?? '')) {
      continued.push(body[++i] ?? '');
    }
    while (continued.length && !continued.at(-1)?.trim()) continued.pop();
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(raw)) {
      const indent = Math.min(
        ...continued.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
      );
      const text = continued.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      fields[key] = raw.startsWith('|') ? text.join('\n') : text.join(' ').replace(/\s+/g, ' ');
    } else if (raw === '') {
      // A nested map or list: not a string field.
    } else {
      const value = [raw, ...continued.map((l) => l.trim())].join(' ').trim();
      fields[key] = unquote(value);
    }
  }
  return fields;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, '');
}
