import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SandboxedOutput } from '../sandboxed-output';

// Markdown as the AI and people write it in a Conversation, a Spec or a Brief. Raw HTML is
// never rendered (react-markdown's default), and links open in a new tab without access to
// this one. A fenced ```svg or ```html block (what the AI makes with an Agent Skill, ticket
// 0078) is shown in a sandboxed iframe, never as markup in the page.

/** The language and text of a fenced code block, when `pre` holds exactly one. */
type Element = NonNullable<ExtraProps['node']>;

function fencedBlock(node: Element | undefined): { lang: string; text: string } | null {
  const code = node?.children.find((c) => c.type === 'element') as Element | undefined;
  if (code?.tagName !== 'code') return null;
  const classes = code.properties?.className;
  const lang = (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((c) => c.startsWith('language-'))
    ?.slice('language-'.length)
    .toLowerCase();
  if (!lang) return null;
  const text = code.children.map((c) => (c.type === 'text' ? c.value : '')).join('');
  return { lang, text: text.replace(/\n$/, '') };
}

export const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // A GFM task item ("- [x] ...") renders a disabled checkbox with no label of its own; it
  // says whether the item is done, and the item's text follows it.
  input: ({ node: _node, ...props }) => (
    <input {...props} aria-label={props.checked ? 'Done' : 'Not done'} />
  ),
  pre: ({ node, ...props }) => {
    const block = fencedBlock(node);
    if (block && (block.lang === 'svg' || block.lang === 'html') && block.text.trim()) {
      return <SandboxedOutput kind={block.lang} source={block.text} />;
    }
    return <pre {...props} />;
  },
};

/**
 * The rendered Markdown alone, without a wrapper. A Server Component can render it and hand
 * it to a Client Component (the Spec and Brief panels), so the Markdown renderer stays off
 * that page's client bundle.
 */
export function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  );
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <MarkdownContent>{children}</MarkdownContent>
    </div>
  );
}
