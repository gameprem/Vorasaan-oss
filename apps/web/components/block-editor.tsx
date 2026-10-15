'use client';

// The BlockNote editor. It touches the DOM as soon as it is created, so it is only ever
// loaded in the browser (see SpecEditor's dynamic import with `ssr: false`).
//
// Markdown is the stored format (ADR 0002): the Spec's Markdown is parsed into blocks when
// the editor opens and serialized back with BlockNote's Markdown export when saving.

import { BlockNoteView } from '@blocknote/ariakit';
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import '@blocknote/ariakit/style.css';
import { type RefObject, useEffect, useMemo } from 'react';

// BlockNote renders a check-list item's checkbox without a label (axe: label). Name it as the
// item renders, before ProseMirror attaches it: ProseMirror re-renders a node view on any later
// DOM change inside it, so labelling it afterwards would loop. Ticking re-renders the item, so
// the name follows its state.
const checkList = defaultBlockSpecs.checkListItem;
type Render = typeof checkList.implementation.render;
const labelledCheckList: typeof checkList = {
  ...checkList,
  implementation: {
    ...checkList.implementation,
    render(this: ThisParameterType<Render>, ...args: Parameters<Render>) {
      const rendered = checkList.implementation.render.apply(this, args);
      rendered.dom
        .querySelector('input[type=checkbox]')
        ?.setAttribute('aria-label', args[0].props.checked ? 'Done' : 'Not done');
      return rendered;
    },
  },
};
const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, checkListItem: labelledCheckList },
});

export default function BlockEditor({
  label,
  markdown,
  getMarkdown,
  onChange,
}: {
  /** The editable area's accessible name ("Spec"). */
  label: string;
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
  const editor = useCreateBlockNote({
    schema,
    initialContent,
    domAttributes: { editor: { 'aria-label': label } },
  });

  useEffect(() => {
    getMarkdown.current = () => editor.blocksToMarkdownLossy(editor.document);
    return () => {
      getMarkdown.current = null;
    };
  }, [editor, getMarkdown]);

  return <BlockNoteView editor={editor} theme="light" onChange={onChange} />;
}
