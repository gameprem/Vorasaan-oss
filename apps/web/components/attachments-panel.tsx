'use client';

import { ATTACHMENT_FILE_TYPES, type AttachmentView } from '@vorasaan/shared';
import { useRouter } from 'next/navigation';
import { useActionState, useRef, useState, useTransition } from 'react';
import {
  addLinkAttachment,
  deleteAttachment,
  draftSpecFromAttachments,
  type FeatureActionState,
  refreshAttachment,
} from '@/lib/feature-actions';
import { relativeTime } from './bits';
import { field, primaryButton, secondaryButton } from './ui';

const SOURCE_LABEL: Record<AttachmentView['source'], string> = {
  FILE: 'File',
  URL: 'Web page',
  CONFLUENCE: 'Confluence',
  JIRA: 'Jira',
  REPO_SCAN: 'Repo Scan',
};

const ACCEPT = Object.keys(ATTACHMENT_FILE_TYPES)
  .map((ext) => `.${ext}`)
  .join(',');

/** Only http(s) links are rendered as links; anything else is shown as text. */
const isWebLink = (url: string) => /^https?:\/\//i.test(url);

export function AttachmentsPanel({
  featureId,
  attachments,
  canEdit,
  canDraft,
}: {
  featureId: string;
  attachments: AttachmentView[];
  /** Role Owners and Admins add, refresh and remove Attachments. */
  canEdit: boolean;
  /** POs and Admins draft a Spec from them. */
  canDraft: boolean;
}) {
  const withText = attachments.some((a) => a.snapshotText?.trim());
  return (
    <div className="max-w-4xl">
      <p className="text-ink-soft">
        Files and pages the AI reads as context. Each one is captured as a Snapshot; Refresh
        captures it again.
      </p>

      {canDraft && <DraftFromAttachments featureId={featureId} enabled={withText} />}

      {canEdit && (
        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <UploadForm featureId={featureId} />
          <LinkForm featureId={featureId} />
        </div>
      )}

      <h2 className="mt-10 text-lg font-semibold">
        Attachments{attachments.length > 0 ? ` (${attachments.length})` : ''}
      </h2>
      {attachments.length === 0 ? (
        <p className="mt-2 text-ink-soft">
          No Attachments yet.
          {canEdit
            ? ' Upload a file or add a link above.'
            : ' Role Owners of this Feature add them.'}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-rule border-y border-rule">
          {attachments.map((a) => (
            <AttachmentItem key={a.id} featureId={featureId} attachment={a} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DraftFromAttachments({ featureId, enabled }: { featureId: string; enabled: boolean }) {
  const [state, run, pending] = useActionState<FeatureActionState>(
    draftSpecFromAttachments.bind(null, featureId),
    {},
  );
  return (
    <form action={run} className="mt-6 rounded-xl border border-rule bg-sheet p-5">
      <p className="font-medium">Draft Spec from Attachments</p>
      <p className="mt-1 text-sm text-ink-soft">
        The AI drafts a Spec Proposal from the Snapshots below. You review the change and approve it
        before it becomes a Spec Version.
      </p>
      <button type="submit" disabled={!enabled || pending} className={`${primaryButton} mt-4`}>
        {pending ? 'Drafting… (this can take a minute)' : 'Draft Spec from Attachments'}
      </button>
      {!enabled && (
        <p className="mt-2 text-sm text-ink-soft">Add an Attachment with text to draft from.</p>
      )}
      {state.error && (
        <p role="alert" className="mt-2 text-seal">
          {state.error}
        </p>
      )}
    </form>
  );
}

function UploadForm({ featureId }: { featureId: string }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const upload = (formData: FormData) =>
    start(async () => {
      setError(undefined);
      const file = formData.get('file');
      if (!(file instanceof File) || file.size === 0) {
        setError('Choose a file to upload.');
        return;
      }
      // The API reads the title field before the file, so it goes first.
      const body = new FormData();
      const title = String(formData.get('title') ?? '').trim();
      if (title) body.append('title', title);
      body.append('file', file);
      try {
        const res = await fetch(`/api/features/${featureId}/attachments`, {
          method: 'POST',
          body,
        });
        if (!res.ok) {
          const reply = (await res.json().catch(() => ({}))) as { message?: unknown };
          setError(
            typeof reply.message === 'string'
              ? reply.message
              : Array.isArray(reply.message)
                ? reply.message.join('; ')
                : `Upload failed (${res.status})`,
          );
          return;
        }
      } catch {
        setError('Upload failed. Check your connection and try again.');
        return;
      }
      form.current?.reset();
      router.refresh();
    });

  return (
    <form ref={form} action={upload} aria-label="Upload a file">
      <h3 className="font-medium">Upload a file</h3>
      <p className="text-sm text-ink-soft">Markdown, text, PDF or an image.</p>
      <label className="mt-3 block">
        <span className="text-sm">File</span>
        <input name="file" type="file" required accept={ACCEPT} className={`${field} text-sm`} />
      </label>
      <label className="mt-3 block">
        <span className="text-sm">Title (optional, defaults to the file name)</span>
        <input name="title" maxLength={200} className={field} />
      </label>
      <button type="submit" disabled={pending} className={`${primaryButton} mt-4`}>
        {pending ? 'Uploading…' : 'Upload'}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-seal">
          {error}
        </p>
      )}
    </form>
  );
}

function LinkForm({ featureId }: { featureId: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [source, setSource] = useState<'URL' | 'CONFLUENCE' | 'JIRA'>('URL');
  const [state, run, pending] = useActionState<FeatureActionState, FormData>(
    async (prev, formData) => {
      const result = await addLinkAttachment(featureId, prev, formData);
      if (result.ok) form.current?.reset();
      return result;
    },
    {},
  );
  return (
    <form ref={form} action={run} aria-label="Add a link">
      <h3 className="font-medium">Add a link</h3>
      <p className="text-sm text-ink-soft">A public web page, a Confluence page or a Jira issue.</p>
      <label className="mt-3 block">
        <span className="text-sm">Kind</span>
        <select
          name="source"
          value={source}
          onChange={(e) => setSource(e.target.value as typeof source)}
          className={field}
        >
          <option value="URL">Web page</option>
          <option value="CONFLUENCE">Confluence page</option>
          <option value="JIRA">Jira issue</option>
        </select>
      </label>
      <label className="mt-3 block">
        <span className="text-sm">
          {source === 'URL'
            ? 'Address'
            : source === 'CONFLUENCE'
              ? 'Page link or page id'
              : 'Issue key or link'}
        </span>
        <input
          name="ref"
          required
          placeholder={
            source === 'URL'
              ? 'https://example.com/pricing'
              : source === 'CONFLUENCE'
                ? 'https://acme.atlassian.net/wiki/spaces/…'
                : 'MB-42'
          }
          className={field}
        />
      </label>
      <label className="mt-3 block">
        <span className="text-sm">Title (optional)</span>
        <input name="title" maxLength={200} className={field} />
      </label>
      <button type="submit" disabled={pending} className={`${primaryButton} mt-4`}>
        {pending ? 'Capturing…' : 'Add'}
      </button>
      {state.error && (
        <p role="alert" className="mt-2 text-seal">
          {state.error}
        </p>
      )}
    </form>
  );
}

function AttachmentItem({
  featureId,
  attachment: a,
  canEdit,
}: {
  featureId: string;
  attachment: AttachmentView;
  canEdit: boolean;
}) {
  const [refreshState, refresh, refreshing] = useActionState<FeatureActionState>(
    refreshAttachment.bind(null, featureId, a.id),
    {},
  );
  const [deleteState, remove, deleting] = useActionState<FeatureActionState>(
    deleteAttachment.bind(null, featureId, a.id),
    {},
  );
  const error = refreshState.error ?? deleteState.error;
  const busy = refreshing || deleting;

  return (
    <li className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words">{a.title}</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            {SOURCE_LABEL[a.source]}, added by {a.addedBy.name} {relativeTime(a.createdAt)}
            {a.snapshotAt && `. Snapshot ${relativeTime(a.snapshotAt)}`}
          </p>
          {a.url &&
            (isWebLink(a.url) ? (
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block truncate text-sm underline underline-offset-2"
              >
                {a.url}
              </a>
            ) : (
              <p className="mt-1 truncate text-sm text-ink-soft">{a.url}</p>
            ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {a.hasFile && (
            <a href={`/api/attachments/${a.id}/file`} className={`${secondaryButton} text-sm`}>
              Download
            </a>
          )}
          {canEdit && a.source !== 'REPO_SCAN' && (
            <form action={refresh}>
              <button type="submit" disabled={busy} className={`${secondaryButton} text-sm`}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </form>
          )}
          {canEdit && (
            <form
              action={remove}
              onSubmit={(e) => {
                if (!window.confirm(`Remove “${a.title}”? The AI stops using it as context.`)) {
                  e.preventDefault();
                }
              }}
            >
              <button type="submit" disabled={busy} className={`${secondaryButton} text-sm`}>
                {deleting ? 'Removing…' : 'Remove'}
              </button>
            </form>
          )}
        </div>
      </div>
      {a.summary && (
        <p className="mt-3">
          <span className="text-sm font-medium text-ink-soft">AI summary: </span>
          {a.summary}
        </p>
      )}
      {a.snapshotText ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">View Snapshot</summary>
          {/* Captured text is shown as text, never rendered as HTML or Markdown. */}
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-rule bg-paper p-4 font-mono text-[13px] leading-6 whitespace-pre-wrap break-words">
            {a.snapshotText}
          </pre>
        </details>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">No text Snapshot (the AI can't read this one).</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-seal">
          {error}
        </p>
      )}
    </li>
  );
}
