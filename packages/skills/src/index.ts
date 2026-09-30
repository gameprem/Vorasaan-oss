// Prompt templates live as Markdown in ../prompts so non-developers can edit them.
// Placeholders are written {{name}}; every placeholder must be supplied.

export const SKILLS = ['generate-choices', 'draft-spec-proposal'] as const;
export type SkillName = (typeof SKILLS)[number];

const promptsDir = new URL('../prompts/', import.meta.url);

export async function loadSkill(name: SkillName): Promise<string> {
  return Bun.file(new URL(`${name}.md`, promptsDir)).text();
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing value for placeholder {{${key}}}`);
    return value;
  });
  return rendered;
}

export async function renderSkill(name: SkillName, values: Record<string, string>) {
  return renderTemplate(await loadSkill(name), values);
}
