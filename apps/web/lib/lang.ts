import { headers } from 'next/headers';

/** The languages the web speaks in the greeting, starters and Grilling (tickets 0046, 0047). */
export type Lang = 'en' | 'th';

/**
 * The visitor's language, from the browser's Accept-Language: Thai when Thai comes before
 * English, English otherwise. Nothing stores a language preference yet.
 */
export function preferredLanguage(header: string | null): Lang {
  const tags = (header ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().toLowerCase().split(';');
      const q = Number(
        params
          .find((p) => p.trim().startsWith('q='))
          ?.trim()
          .slice(2) ?? 1,
      );
      return { tag, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((t) => t.tag && t.q > 0)
    .sort((a, b) => b.q - a.q);
  const first = tags.find((t) => t.tag.startsWith('th') || t.tag.startsWith('en'));
  return first?.tag.startsWith('th') ? 'th' : 'en';
}

/** The language of the request being rendered. Server-only. */
export async function requestLanguage(): Promise<Lang> {
  return preferredLanguage((await headers()).get('accept-language'));
}
