// Readable text from an HTML page, with Bun's built-in streaming HTMLRewriter
// (no DOM). Drops scripts, styles and site chrome, keeps block structure as
// line breaks, and prefers <main>/<article> when the page has one.

/** Content that is never readable text. */
const SKIP = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'canvas',
  'nav',
  'footer',
]);

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

const HEADING = /^h([1-6])$/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

export function htmlToText(html: string): { title: string | null; text: string } {
  let all = '';
  let main = '';
  let title = '';
  let skipDepth = 0;
  let mainDepth = 0;
  let preDepth = 0;
  let inTitle = false;

  // Collapsed text drops its leading space after whitespace, so spaces never pile up.
  const append = (buffer: string, chunk: string, collapsed: boolean) =>
    collapsed && chunk.startsWith(' ') && (buffer === '' || /\s$/.test(buffer))
      ? buffer + chunk.slice(1)
      : buffer + chunk;
  const emit = (chunk: string, collapsed = false) => {
    all = append(all, chunk, collapsed);
    if (mainDepth > 0) main = append(main, chunk, collapsed);
  };
  /** Runs `onEnd` at the element's end tag, when it can have one. */
  const atEnd = (element: HTMLRewriterTypes.Element, onEnd: () => void) => {
    try {
      element.onEndTag(onEnd);
      return true;
    } catch {
      return false; // void or self-closing element
    }
  };

  new HTMLRewriter()
    .on('title', {
      element(element) {
        inTitle = true;
        atEnd(element, () => {
          inTitle = false;
        });
      },
    })
    .on('*', {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (SKIP.has(tag)) {
          if (atEnd(element, () => skipDepth--)) skipDepth++;
          return;
        }
        if (skipDepth > 0) return;
        if (tag === 'main' || tag === 'article') {
          if (atEnd(element, () => mainDepth--)) mainDepth++;
        }
        if (tag === 'pre' && atEnd(element, () => preDepth--)) preDepth++;
        const level = HEADING.exec(tag)?.[1];
        if (level) emit(`\n\n${'#'.repeat(Number(level))} `);
        else if (tag === 'li') emit('\n- ');
        else if (BLOCK.has(tag)) emit('\n');
        if (BLOCK.has(tag) || level) atEnd(element, () => emit('\n'));
      },
    })
    .onDocument({
      text(chunk) {
        if (inTitle) {
          title += chunk.text;
          return;
        }
        if (skipDepth > 0) return;
        if (preDepth > 0) emit(chunk.text);
        else emit(chunk.text.replace(/\s+/g, ' '), true);
      },
    })
    .transform(html);

  const cleanTitle = decodeEntities(title).replace(/\s+/g, ' ').trim();
  return { title: cleanTitle || null, text: tidy(decodeEntities(main.trim() ? main : all)) };
}

/** Trims every line and collapses runs of blank lines. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
