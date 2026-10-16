'use client';

import { lazy, Suspense } from 'react';

// The chat's Markdown renderer (react-markdown and remark-gfm) loads in its own chunk, not in
// the chat page's first load. A new Conversation has nothing to render yet, and a server-
// rendered message keeps its HTML until the chunk arrives. Until then a message shows its
// text as written, so it can be read at once.

const loadMarkdown = () => import('./markdown');

const Rendered = lazy(() => loadMarkdown().then((m) => ({ default: m.Markdown })));

/** Starts loading the renderer, so it is ready before the first reply arrives. */
export function preloadMarkdown() {
  void loadMarkdown();
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <Suspense
      fallback={
        <div className={`whitespace-pre-wrap ${className ? `md ${className}` : 'md'}`}>
          {children}
        </div>
      }
    >
      <Rendered className={className}>{children}</Rendered>
    </Suspense>
  );
}
