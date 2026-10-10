import type { Prisma, PrismaClient } from '@vorasaan/db';
import { ChatLanguage, DEFAULT_CHAT_LANGUAGE } from '@vorasaan/shared';

// The language the AI replies in (ticket 0068). Every prompt carries the same
// language rules (packages/skills/prompts/partials/language.md) and the reply
// language of the call: that of the person whose action makes the call (their
// ChatPreference.language, the one language setting a person has, 0058/0063),
// else their Organization's, else English. What runs as a Grilling moves on and
// is written for a Team Role or the whole Project (Grilling questions, the Brief
// drafted from a Grilling) uses the Organization's.

/** A language the AI replies in: the languages the product speaks. */
export type ReplyLanguage = ChatLanguage;

/** How the prompt names each language to the model. */
export const LANGUAGE_NAME: Record<ReplyLanguage, string> = {
  en: 'English',
  th: 'Thai (ภาษาไทย)',
};

/**
 * How the model gets to the reply language. `direct` is what the product uses:
 * answer in the reply language without going through English. `english-first`
 * exists only to be measured against it on the eval sets (`--english-first`).
 */
export type LanguageStrategy = 'direct' | 'english-first';

const STRATEGY_RULE: Record<LanguageStrategy, string> = {
  direct:
    'Think and write directly in the reply language. Do not translate the material into English first, and do not draft in English and then translate.',
  'english-first':
    'Work the task out in English first, then write the final output in the reply language. The rules below hold in both steps: what they list stays as written.',
};

/** What a prompt is rendered with for its language rules. */
export type PromptLanguage = { language?: ReplyLanguage; strategy?: LanguageStrategy };

/** The values of the language partial's placeholders. */
export function languageValues(lang: PromptLanguage = {}): {
  replyLanguage: string;
  languageStrategy: string;
} {
  return {
    replyLanguage: LANGUAGE_NAME[lang.language ?? DEFAULT_CHAT_LANGUAGE],
    languageStrategy: STRATEGY_RULE[lang.strategy ?? 'direct'],
  };
}

/** A stored language, or null when it isn't one the product speaks. */
export function asReplyLanguage(value: string | null | undefined): ReplyLanguage | null {
  const parsed = ChatLanguage.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** A person's language: their own, else their Organization's, else English. */
export async function personLanguage(db: Db, userId: string): Promise<ReplyLanguage> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      chatPreference: { select: { language: true } },
      orgMemberships: { select: { organization: { select: { language: true } } }, take: 1 },
    },
  });
  return (
    asReplyLanguage(user?.chatPreference?.language) ??
    asReplyLanguage(user?.orgMemberships[0]?.organization.language) ??
    DEFAULT_CHAT_LANGUAGE
  );
}

/** The language of a Project's Organization, else English. */
export async function projectLanguage(db: Db, projectId: string): Promise<ReplyLanguage> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organization: { select: { language: true } } },
  });
  return asReplyLanguage(project?.organization.language) ?? DEFAULT_CHAT_LANGUAGE;
}
