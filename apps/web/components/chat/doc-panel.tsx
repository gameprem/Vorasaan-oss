'use client';

import type { ActionCardView } from '@vorasaan/shared';
import Link from 'next/link';
import { type Ref, useId } from 'react';
import { CloseIcon, ExternalIcon } from '../icons';
import { SpecDiff } from '../spec-diff';
import { Markdown } from './markdown';

// The document beside the chat (ADR 0008): the Feature's latest Spec or the Project's
// latest Brief, as a rounded sheet. A proposal still waiting in this Conversation shows
// on top as a diff. On narrow screens it is an overlay (see .chat-doc in globals.css).

export type ChatDoc = {
  kind: 'SPEC' | 'BRIEF';
  /** The Feature's title or the Project's name. */
  title: string;
  /** 0 while there is none yet. */
  version: number;
  markdown: string;
  approvedBy: string | null;
  /** The Feature or Project page, with the history, the editor and the other tabs. */
  href: string;
};

export function docName(doc: Pick<ChatDoc, 'kind'>) {
  return doc.kind === 'SPEC' ? 'Spec' : 'Project Brief';
}

export function DocPanel({
  id,
  doc,
  pending,
  onClose,
  closeRef,
}: {
  id: string;
  doc: ChatDoc;
  /** The newest proposal for this document still PROPOSED in the Conversation. */
  pending: ActionCardView | null;
  onClose: () => void;
  closeRef: Ref<HTMLButtonElement>;
}) {
  const headingId = useId();
  const name = docName(doc);
  const detail = pending?.detail;
  const diff =
    detail?.kind === 'SPEC_PROPOSAL' || detail?.kind === 'BRIEF_PROPOSAL' ? detail : null;

  return (
    <aside
      id={id}
      className="chat-doc"
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="doc-inner">
        <div className="doc-head">
          <b id={headingId} className="doc-title">
            {name}
          </b>
          {doc.version > 0 ? (
            <span className="v">
              v{doc.version}
              {doc.approvedBy ? ` · approved by ${doc.approvedBy}` : ''}
            </span>
          ) : (
            <span className="v none">none yet</span>
          )}
          <span className="flex-1" />
          <Link
            href={doc.href}
            className="icon-btn"
            aria-label={`Open the ${doc.kind === 'SPEC' ? 'Feature' : 'Project'} page`}
            title={`Open the ${doc.kind === 'SPEC' ? 'Feature' : 'Project'} page`}
          >
            <ExternalIcon />
          </Link>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label={`Close the ${name} panel`}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard */}
        <section className="doc-body" tabIndex={0} aria-label={`${name} text`}>
          {diff && (
            <section className="doc-pending" aria-label="Proposed change">
              <p>
                <b>Proposed change</b> · waiting for {diff.approver.name} to approve it
              </p>
              <SpecDiff before={diff.baseMarkdown} after={diff.proposedMarkdown} />
            </section>
          )}
          {doc.version > 0 ? (
            <Markdown className="doc-md">{doc.markdown}</Markdown>
          ) : (
            <p className="text-fg-soft">
              {doc.kind === 'SPEC'
                ? `${doc.title} has no Spec yet. Ask the AI to draft one from the Attachments.`
                : `${doc.title} has no Project Brief yet. Ask the AI to draft one, or start a Grilling.`}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
