'use client';

// The BlockNote editor. It touches the DOM as soon as it is created, so it is only ever
// loaded in the browser (see SpecEditor's dynamic import with `ssr: false`).
//
// Markdown is the stored format (ADR 0002): the Spec's Markdown is parsed into blocks when
// the editor opens and serialized back with BlockNote's Markdown export when saving.

import { BlockNoteView } from '@blocknote/ariakit';
import { BlockNoteEditor } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import '@blocknote/ariakit/style.css';
import { type RefObject, useEffect, useMemo } from 'react';

export default function BlockEditor({
  markdown,
  getMarkdown,
  onChange,
}: {
  markdown: string;
  /** Set to a function that returns the editor's current content as Markdown. */
  getMarkdown: RefObject<(() => string) | null>;
  onChange?: () => void;
}) {
  // Parse once, when the editor opens; later edits live in the editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the initial content only
  const initialContent = useMemo(() => {
    const blocks = BlockNoteEditor.create().tryParseMarkdownToBlocks(markdown);
    return blocks.length > 0 ? blocks : undefined;
  }, []);
  const editor = useCreateBlockNote({ initialContent });

  useEffect(() => {
    getMarkdown.current = () => editor.blocksToMarkdownLossy(editor.document);
    return () => {
      getMarkdown.current = null;
    };
  }, [editor, getMarkdown]);

  return <BlockNoteView editor={editor} theme="light" onChange={onChange} />;
}
