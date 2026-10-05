'use client';

import Link from 'next/link';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { saveSpec } from '@/lib/feature-actions';
import { type SaveMarkdownInput, SpecEditor } from './spec-editor';
import { secondaryButton } from './ui';

/** Shows the latest Spec, with "Edit Spec" for people allowed to write it. */
export function SpecPanel({
  featureId,
  markdown,
  version,
  meta,
  canEdit,
  template,
}: {
  featureId: string;
  /** What a first Spec starts from: a section per target Platform (from the server). */
  template?: string;
  markdown: string | null;
  version: number;
  meta: string | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const save = (input: SaveMarkdownInput) => saveSpec(featureId, input);

  if (!markdown) {
    return canEdit ? (
      <div>
        <p className="mb-4 text-fg-soft">
          This Feature has no Spec yet. Write the first version; the team and AI build from it. Or
          add Attachments and{' '}
          <Link
            href={`/features/${featureId}?tab=attachments`}
            className="text-fg underline underline-offset-2"
          >
            draft a Spec from them
          </Link>
          .
        </p>
        <SpecEditor key={template} save={save} current={null} baseVersion={0} template={template} />
      </div>
    ) : (
      <p className="text-fg-soft">This Feature has no Spec yet. Its PO writes the first version.</p>
    );
  }

  if (editing) {
    return (
      <SpecEditor
        save={save}
        current={markdown}
        baseVersion={version}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-soft">{meta}</p>
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} className={secondaryButton}>
            Edit Spec
          </button>
        )}
      </div>
      <div className="spec rounded-sheet bg-rail p-6 sm:p-10">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </>
  );
}
