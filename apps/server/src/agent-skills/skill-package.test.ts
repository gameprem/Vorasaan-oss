import { describe, expect, test } from 'bun:test';
import { buildZip } from '../test/zip.ts';
import { agentSkillLimits } from './agent-skills.config.ts';
import {
  FLOW_DIAGRAM_SKILL_MD,
  FLOW_DIAGRAM_TEMPLATE_SVG,
  flowDiagramFiles,
} from './fixtures/flow-diagram.ts';
import {
  frontmatter,
  readSkillZip,
  SkillPackageError,
  SkillTooLargeError,
  skillMetadata,
  zipPin,
} from './skill-package.ts';
import { isSafeRelativePath, readZipEntries, ZipError } from './zip-reader.ts';

const limits = agentSkillLimits({});

describe('reading a Skill from a zip (ticket 0078)', () => {
  test('keeps SKILL.md, references and assets; lists scripts, binaries and links as skipped', () => {
    const pkg = readSkillZip(buildZip(flowDiagramFiles()), { limits });
    expect(pkg.name).toBe('flow-diagram');
    expect(pkg.description).toStartWith('Draws a product flow as one clean SVG diagram');
    expect(pkg.license).toBe('MIT');
    expect(pkg.files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'assets/template.svg',
      'references/style.md',
    ]);
    expect(new TextDecoder().decode(pkg.files[1]?.data)).toBe(FLOW_DIAGRAM_TEMPLATE_SVG);
    expect(pkg.skipped).toEqual([
      { path: 'assets/latest', reason: 'LINK' },
      { path: 'assets/logo.png', reason: 'NOT_TEXT' },
      { path: 'scripts/build', reason: 'SCRIPT' },
      { path: 'scripts/render.py', reason: 'SCRIPT' },
    ]);
    expect(pkg.totalBytes).toBe(pkg.files.reduce((n, f) => n + f.data.byteLength, 0));
  });

  test('finds the Skill under a single top folder, or by its folder', () => {
    const nested = buildZip(flowDiagramFiles().map((f) => ({ ...f, path: `repo-1/${f.path}` })));
    expect(readSkillZip(nested, { limits }).name).toBe('flow-diagram');
    const many = buildZip([
      ...flowDiagramFiles().map((f) => ({ ...f, path: `skills/flow/${f.path}` })),
      { path: 'skills/other/SKILL.md', data: '---\nname: other\ndescription: Other.\n---\n' },
    ]);
    expect(() => readSkillZip(many, { limits })).toThrow(/several Skills/);
    expect(readSkillZip(many, { limits, subpath: 'skills/other' }).name).toBe('other');
    expect(() => readSkillZip(many, { limits, subpath: 'skills/none' })).toThrow(
      /no SKILL.md in the folder/,
    );
  });

  test('refuses a zip with a path outside its folder, an absolute path or a backslash', () => {
    for (const path of [
      '../evil/SKILL.md',
      'a/../../SKILL.md',
      '/etc/passwd',
      'a\\..\\b',
      'C:/x',
    ]) {
      const zip = buildZip([
        { path: 'SKILL.md', data: FLOW_DIAGRAM_SKILL_MD },
        { path, data: 'x' },
      ]);
      expect(() => readSkillZip(zip, { limits })).toThrow(ZipError);
    }
    expect(isSafeRelativePath('references/style.md')).toBe(true);
    expect(isSafeRelativePath('references/./style.md')).toBe(false);
  });

  test('refuses a file or a Skill over the size limits, and a zip bomb', () => {
    const big = 'x'.repeat(2_000);
    const small = { ...limits, maxFileBytes: 1_000 };
    const zip = buildZip([...flowDiagramFiles(), { path: 'references/big.md', data: big }]);
    expect(() => readSkillZip(zip, { limits: small })).toThrow(SkillTooLargeError);
    expect(() =>
      readSkillZip(buildZip(flowDiagramFiles()), { limits: { ...limits, maxSkillBytes: 500 } }),
    ).toThrow(/larger than 500 bytes together/);
    expect(() =>
      readSkillZip(buildZip(flowDiagramFiles()), { limits: { ...limits, maxFiles: 2 } }),
    ).toThrow(/more than 2 files/);
    expect(() =>
      readSkillZip(buildZip(flowDiagramFiles()), { limits: { ...limits, maxArchiveBytes: 100 } }),
    ).toThrow(/zip is larger than 100 bytes/);
    // A header claiming 10 bytes for 2 MB of zeros: the inflater is capped, nothing grows.
    const bomb = buildZip([
      { path: 'SKILL.md', data: FLOW_DIAGRAM_SKILL_MD },
      { path: 'references/bomb.md', data: new Uint8Array(2_000_000), declaredSize: 10 },
    ]);
    expect(() => readSkillZip(bomb, { limits })).toThrow(SkillTooLargeError);
  });

  test('refuses what is not a Skill', () => {
    expect(() => readSkillZip(new Uint8Array([1, 2, 3]), { limits })).toThrow(ZipError);
    expect(() => readSkillZip(buildZip([{ path: 'README.md', data: '# x' }]), { limits })).toThrow(
      /no SKILL.md/,
    );
    const noName = buildZip([{ path: 'SKILL.md', data: '---\ndescription: d\n---\n' }]);
    expect(() => readSkillZip(noName, { limits })).toThrow(SkillPackageError);
    expect(() => skillMetadata('# No frontmatter')).toThrow(/no frontmatter/);
    expect(() => skillMetadata(`---\nname: x\ndescription: ${'d'.repeat(1_100)}\n---`)).toThrow(
      /longer than 1024/,
    );
    expect(() => skillMetadata('---\nname: "a\\nb"\ndescription: d\n---')).toThrow(/one line/);
  });

  test('reads frontmatter: quoted, folded, literal and continued values; nested maps skipped', () => {
    const fields = frontmatter(
      [
        '---',
        'name: "diagram-design"',
        "license: 'MIT'",
        'description: >',
        '  Makes diagrams',
        '  in SVG.',
        'notes: |',
        '  line one',
        '  line two',
        'metadata:',
        '  author: someone',
        'plain: first part',
        '  second part # a comment',
        '---',
        'Body',
      ].join('\n'),
    );
    expect(fields).toEqual({
      name: 'diagram-design',
      license: 'MIT',
      description: 'Makes diagrams in SVG.',
      notes: 'line one\nline two',
      plain: 'first part second part',
    });
  });

  test('pins a zip to its SHA-256, and lists entries without reading them', () => {
    const zip = buildZip(flowDiagramFiles());
    expect(zipPin(zip)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readZipEntries(zip).find((e) => e.path === 'assets/latest')?.link).toBe(true);
  });
});
