// Plain text from Atlassian Document Format (Jira Cloud descriptions). Kept
// simple: text, line breaks, paragraphs, headings, lists, code, tables, and the
// visible text of mentions, emoji and links. Unknown nodes keep their children.

type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
};

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'panel',
  'rule',
  'bulletList',
  'orderedList',
  'table',
  'mediaSingle',
  'expand',
]);

function render(node: AdfNode, listDepth: number): string {
  const children = (depth = listDepth) =>
    (node.content ?? []).map((child) => render(child, depth)).join('');
  const attr = (name: string) =>
    typeof node.attrs?.[name] === 'string' ? (node.attrs[name] as string) : '';

  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return attr('text') || '@someone';
    case 'emoji':
      return attr('text') || attr('shortName');
    case 'inlineCard':
    case 'blockCard':
      return attr('url');
    case 'rule':
      return '\n---\n';
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `\n\n${'#'.repeat(level)} ${children().trim()}\n\n`;
    }
    case 'bulletList':
    case 'orderedList':
      return `\n${children(listDepth + 1)}\n`;
    case 'listItem':
      return `\n${'  '.repeat(Math.max(listDepth - 1, 0))}- ${children().trim()}`;
    case 'tableRow':
      return `\n${(node.content ?? []).map((cell) => render(cell, listDepth).trim()).join(' | ')}`;
    case 'codeBlock':
      return `\n\n${children()}\n\n`;
    default:
      return BLOCKS.has(node.type ?? '') ? `\n\n${children()}\n\n` : children();
  }
}

/** A Jira description: ADF (API v3), a plain string (API v2), or nothing. */
export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc.trim();
  if (!doc || typeof doc !== 'object') return '';
  return render(doc as AdfNode, 0)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
