'use client';

import { BRIEF_TEMPLATE } from '@vorasaan/shared';
import { type ReactNode, useState } from 'react';
import { saveBrief } from '@/lib/project-actions';
import { type SaveMarkdownInput, SpecEditor } from './spec-editor';
import { secondaryButton } from './ui';

/**
 * The current Project Brief, rendered from Markdown (raw HTML is never rendered), with the
 * BlockNote editor for its editors (Admins and POs of the Project's Teams).
 */
export function BriefPanel({
  projectId,
  markdown,
  rendered,
  version,
  meta,
  canEdit,
}: {
  projectId: string;
  markdown: string;
  /** `markdown` rendered on the server (`MarkdownContent`), so the renderer isn't shipped here. */
  rendered: ReactNode;
  /** 0 while the Brief is still the empty template. */
  version: number;
  meta: string | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const save = (input: SaveMarkdownInput) => saveBrief(projectId, input);

  if (editing) {
    return (
      <SpecEditor
        save={save}
        noun="Project Brief"
        template={BRIEF_TEMPLATE}
        current={version === 0 ? null : markdown}
        baseVersion={version}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-soft">
          {meta ??
            (canEdit
              ? 'No Project Brief yet: this is the empty template. Write it yourself, or start a Grilling and let the AI draft it from your answers.'
              : 'No Project Brief yet. The Project’s POs write it or start a Grilling.')}
        </p>
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} className={secondaryButton}>
            {version === 0 ? 'Write the Project Brief' : 'Edit Project Brief'}
          </button>
        )}
      </div>
      <div
        className={`spec rounded-sheet bg-rail p-6 sm:p-10 ${version === 0 ? 'text-fg-soft' : ''}`}
      >
        {rendered}
      </div>
    </>
  );
}
