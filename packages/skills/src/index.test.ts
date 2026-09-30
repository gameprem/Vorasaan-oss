import { describe, expect, test } from 'bun:test';
import { loadSkill, renderTemplate, SKILLS } from './index.ts';

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
