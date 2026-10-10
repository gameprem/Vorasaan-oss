// Prompt templates live as Markdown in ../prompts so non-developers can edit them.
// Placeholders are written {{name}}; every placeholder must be supplied.
// `{{cacheBreak}}` marks where a prompt's stable prefix ends (ticket 0061): the
// server cuts the prompt there for prompt caching and sends no text for it.
// Everything above a break must stay the same from one call to the next.
// `{{>name}}` includes a shared block from ../prompts/partials: every prompt
// includes `{{>language}}`, the language rules (ticket 0068).

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
  'draft-acceptance-criteria',
  'chat',
  'summarize-conversation',
  'redraft-choices',
  'redraft-spec-proposal',
  'redraft-brief-proposal',
  'redraft-feature-suggestion',
  'analyze-feedback',
  'propose-prompt-version',
  'redraft-prompt-version',
] as const;
export type SkillName = (typeof SKILLS)[number];

const promptsDir = new URL('../prompts/', import.meta.url);
const partialsDir = new URL('partials/', promptsDir);

/**
 * Shared blocks a prompt includes with `{{>name}}`, from ../prompts/partials. One
 * source for text every prompt must carry, such as the language rules (ticket 0068).
 */
export const PARTIALS = ['language'] as const;
export type PartialName = (typeof PARTIALS)[number];

/** The values the language partial needs: every prompt is rendered with them. */
export const LANGUAGE_PLACEHOLDERS = ['replyLanguage', 'languageStrategy'] as const;

export async function loadPartial(name: PartialName): Promise<string> {
  return (await Bun.file(new URL(`${name}.md`, partialsDir)).text()).trim();
}

/** A template with each `{{>name}}` replaced by that partial. An unknown partial fails. */
export async function expandPartials(template: string): Promise<string> {
  const names = [...template.matchAll(/\{\{>\s*([\w-]+)\s*\}\}/g)].map((m) => m[1] ?? '');
  const texts = new Map<string, string>();
  for (const name of new Set(names)) {
    if (!(PARTIALS as readonly string[]).includes(name)) {
      throw new Error(`Unknown partial {{>${name}}}`);
    }
    texts.set(name, await loadPartial(name as PartialName));
  }
  return template.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_m, name: string) => texts.get(name) ?? '');
}

/** A skill's Markdown as written, partials not expanded. */
export async function readSkillSource(name: SkillName): Promise<string> {
  return Bun.file(new URL(`${name}.md`, promptsDir)).text();
}

/** A skill's template, its partials expanded. */
export async function loadSkill(name: SkillName): Promise<string> {
  return expandPartials(await readSkillSource(name));
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

/** Whether `name` is one of the built-in prompts. */
export function isSkillName(name: string): name is SkillName {
  return (SKILLS as readonly string[]).includes(name);
}

/** The `{{name}}` placeholders a template uses, each once, in order (partials not included). */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? ''))];
}

/** The first 12 hex digits of the SHA-256 of a template (partials already expanded). */
function templateHash(expanded: string): string {
  return new Bun.CryptoHasher('sha256').update(expanded).digest('hex').slice(0, 12);
}

const versions = new Map<SkillName, Promise<string>>();

/**
 * The Prompt Version of a built-in prompt (ticket 0070): `default@` and the first 12 hex
 * digits of the SHA-256 of its template, partials expanded. It changes whenever the text
 * does, so a Receipt says exactly which prompt a call rendered. An Organization's own
 * Prompt Versions (ticket 0071) sit on top of this default: see `promptVersionOf`.
 */
export function skillVersion(name: SkillName): Promise<string> {
  let version = versions.get(name);
  if (!version) {
    version = loadSkill(name).then((template) => `default@${templateHash(template)}`);
    versions.set(name, version);
  }
  return version;
}

/**
 * How Receipts name an Organization's Prompt Version (ticket 0071): `v<number>@` and the
 * hash of its template with its partials expanded, the way the default is named.
 */
export async function promptVersionOf(number: number, template: string): Promise<string> {
  return `v${number}@${templateHash(await expandPartials(template))}`;
}
