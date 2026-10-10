import { describe, expect, test } from 'bun:test';
import {
  expandPartials,
  isSkillName,
  LANGUAGE_PLACEHOLDERS,
  loadPartial,
  loadSkill,
  placeholdersOf,
  promptVersionOf,
  readSkillSource,
  renderTemplate,
  SKILLS,
  skillVersion,
} from './index.ts';

describe('skills', () => {
  test('every skill has a prompt file', async () => {
    for (const name of SKILLS) {
      expect((await loadSkill(name)).length).toBeGreaterThan(100);
    }
  });

  test('renders placeholders', () => {
    expect(renderTemplate('Hi {{name}}, {{name}}!', { name: 'Pim' })).toBe('Hi Pim, Pim!');
  });

  test('fails on a missing placeholder instead of sending it to the model', () => {
    expect(() => renderTemplate('{{spec}}', {})).toThrow('{{spec}}');
  });
});

describe('the language rules (ticket 0068)', () => {
  test('every skill includes the one language partial, once', async () => {
    const rules = await loadPartial('language');
    for (const name of SKILLS) {
      const source = await readSkillSource(name);
      expect(source.match(/\{\{>\s*language\s*\}\}/g)?.length, name).toBe(1);
      const template = await loadSkill(name);
      expect(template, name).toContain(rules);
      for (const key of LANGUAGE_PLACEHOLDERS) expect(template, name).toContain(`{{${key}}}`);
    }
  });

  test('the rules keep terms, names, ids, numbers and quotes as written', async () => {
    const rules = await loadPartial('language');
    for (const kept of [
      '{{replyLanguage}}',
      'Decision Request',
      'the names of Projects, Features, Teams and people',
      'ids',
      'numbers with their units',
      'Never translate inside quotation marks',
    ]) {
      expect(rules).toContain(kept);
    }
  });

  test('a partial is expanded in place; an unknown one fails', async () => {
    const out = await expandPartials('A\n\n{{>language}}\n\nB');
    expect(out.startsWith('A\n\n## Language\n')).toBe(true);
    expect(out.endsWith('.\n\nB')).toBe(true);
    await expect(expandPartials('{{>nope}}')).rejects.toThrow('nope');
  });
});

describe('Prompt Versions of the built-in prompts (ticket 0070)', () => {
  test('each is default@ and a hash of its expanded template, distinct per prompt', async () => {
    const all = await Promise.all(SKILLS.map((name) => skillVersion(name)));
    for (const version of all) expect(version).toMatch(/^default@[0-9a-f]{12}$/);
    expect(new Set(all).size).toBe(SKILLS.length);
    const template = await loadSkill('chat');
    const hash = new Bun.CryptoHasher('sha256').update(template).digest('hex').slice(0, 12);
    expect(await skillVersion('chat')).toBe(`default@${hash}`);
  });
});

describe('Organization Prompt Versions (ticket 0071)', () => {
  test('are v<number>@ and a hash of the expanded template', async () => {
    const template = await readSkillSource('chat');
    const expanded = await loadSkill('chat');
    const hash = new Bun.CryptoHasher('sha256').update(expanded).digest('hex').slice(0, 12);
    expect(await promptVersionOf(3, template)).toBe(`v3@${hash}`);
    expect(await promptVersionOf(4, `${template}\nShorter.`)).not.toContain(hash);
  });

  test('placeholders are listed once each; names are checked', () => {
    expect(placeholdersOf('{{a}} {{b}} {{a}} {{>language}}')).toEqual(['a', 'b']);
    expect(isSkillName('generate-choices')).toBe(true);
    expect(isSkillName('nope')).toBe(false);
  });
});
