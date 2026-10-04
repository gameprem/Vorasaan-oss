import { describe, expect, test } from 'bun:test';
import {
  expandPartials,
  LANGUAGE_PLACEHOLDERS,
  loadPartial,
  loadSkill,
  readSkillSource,
  renderTemplate,
  SKILLS,
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
