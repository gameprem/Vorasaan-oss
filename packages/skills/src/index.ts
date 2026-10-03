// Prompt templates live as Markdown in ../prompts so non-developers can edit them.
// Placeholders are written {{name}}; every placeholder must be supplied.
// `{{cacheBreak}}` marks where a prompt's stable prefix ends (ticket 0061): the
// server cuts the prompt there for prompt caching and sends no text for it.
// Everything above a break must stay the same from one call to the next.

export const SKILLS = [
  'generate-choices',
  'draft-spec-proposal',
  'summarize-attachment',
  'draft-spec-from-attachments',
  'grilling-questions',
  'grilling-follow-up',
  'draft-brief-from-grilling',
  'suggest-features',
  'draft-spec-from-suggestion',
  'check-feature-fit',
  'chat',
  'summarize-conversation',
  'redraft-choices',
  'redraft-spec-proposal',
  'redraft-brief-proposal',
  'redraft-feature-suggestion',
] as const;
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
