'use client';

import Link from 'next/link';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SpecEditor } from './spec-editor';
import { secondaryButton } from './ui';

/** Shows the latest Spec, with "Edit Spec" for people allowed to write it. */
export function SpecPanel({
  featureId,
  markdown,
  version,
  meta,
  canEdit,
}: {
  featureId: string;
  markdown: string | null;
  version: number;
  meta: string | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (!markdown) {
    return canEdit ? (
      <div>
        <p className="mb-4 text-ink-soft">
          This Feature has no Spec yet. Write the first version; the team and AI build from it. Or
          add Attachments and{' '}
          <Link
            href={`/features/${featureId}?tab=attachments`}
            className="text-ink underline underline-offset-2"
          >
            draft a Spec from them
          </Link>
          .
        </p>
        <SpecEditor featureId={featureId} current={null} baseVersion={0} />
      </div>
    ) : (
      <p className="text-ink-soft">
        This Feature has no Spec yet. Its PO writes the first version.
      </p>
    );
  }

  if (editing) {
    return (
      <SpecEditor
        featureId={featureId}
        current={markdown}
        baseVersion={version}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{meta}</p>
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} className={secondaryButton}>
            Edit Spec
          </button>
        )}
      </div>
      <div className="spec rounded-xl border border-rule bg-sheet p-6 sm:p-10">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </>
  );
}
