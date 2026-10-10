// What leaves the server in a Receipt (ticket 0070): never a person's name or email, never
// a key. Free texts (Decline reasons, Request changes feedback, error messages) are
// cleaned here before they are stored or exported.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Things that look like keys or tokens: "sk-…", "Bearer …", long runs of key characters. */
const SECRET_LIKE =
  /\b(?:sk|pk|rk|key|token)[-_][A-Za-z0-9_-]{8,}|\bBearer\s+\S+|[A-Za-z0-9_+/=]{32,}/gi;

/** The longest error message a Receipt keeps. */
export const MAX_ERROR_CHARS = 300;

/**
 * A failed call's error as a Receipt keeps it: its message (and its causes'), with the
 * call's key, anything key-like and any email masked, cut short.
 */
export function receiptError(error: unknown, secrets: (string | null | undefined)[] = []): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && messages.length < 3) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  let text = messages.join(' <- ') || 'Unknown error';
  for (const secret of secrets) {
    if (secret && secret.length >= 8) text = text.replaceAll(secret, '…');
  }
  text = text.replace(SECRET_LIKE, '…').replace(EMAIL, '[email]');
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/**
 * The people of one export: each gets an id ("person-1", "person-2"...) the first time
 * they appear, the same for the rest of the export. In free text, every person's name and
 * email is replaced by their id, and any other email by "[email]".
 */
export class PeopleRedactor {
  private readonly ids = new Map<string, string>();
  private readonly patterns: { pattern: RegExp; userId: string }[];

  constructor(users: { id: string; name: string; email: string }[]) {
    const terms = users.flatMap((u) => [
      // Emails in any case; names as written, so "Oak" doesn't eat "soaked".
      { term: u.email, userId: u.id, flags: 'giu' },
      // A name of one or two letters would replace parts of ordinary words.
      ...(u.name.trim().length >= 3 ? [{ term: u.name.trim(), userId: u.id, flags: 'gu' }] : []),
    ]);
    // Longest first, so "Pim Somchai" is replaced before "Pim".
    terms.sort((a, b) => b.term.length - a.term.length);
    this.patterns = terms.map(({ term, userId, flags }) => ({
      pattern: new RegExp(escapeRegExp(term), flags),
      userId,
    }));
  }

  /** The person's id in this export, or null for nobody. */
  idOf(userId: string | null): string | null {
    if (!userId) return null;
    let id = this.ids.get(userId);
    if (!id) {
      id = `person-${this.ids.size + 1}`;
      this.ids.set(userId, id);
    }
    return id;
  }

  /** `text` with every known name and email, and any other email, replaced. */
  redact(text: string): string {
    let out = text;
    for (const { pattern, userId } of this.patterns) {
      out = out.replace(pattern, () => this.idOf(userId) ?? '');
    }
    return out.replace(EMAIL, '[email]');
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
