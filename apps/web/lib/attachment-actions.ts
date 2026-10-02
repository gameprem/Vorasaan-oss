'use server';

import { AddUrlAttachmentInput, type AttachmentView } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';
import { type AttachmentOwner, isId, isOwner } from './ids';

// Attachment actions for a Feature's or a Project's Attachments. Each one only forwards to the
// API as the signed-in user, which enforces who may do what. The owner arrives from the
// browser, so its kind must be one of the two fixed path segments and its id a UUID.

export type AttachmentActionState = { error?: string; ok?: boolean };

const INVALID: AttachmentActionState = { error: 'That link is not valid. Reload the page.' };

async function attempt(owner: AttachmentOwner, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message } satisfies AttachmentActionState;
    throw error;
  }
  revalidatePath(`/${owner.kind}/${owner.id}`);
  return { ok: true } satisfies AttachmentActionState;
}

/** Attaches a public web page, a Confluence page or a Jira issue. */
export async function addLinkAttachment(
  owner: AttachmentOwner,
  _prev: AttachmentActionState,
  formData: FormData,
): Promise<AttachmentActionState> {
  if (!isOwner(owner)) return INVALID;
  const source = String(formData.get('source') ?? 'URL');
  const ref = String(formData.get('ref') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim() || undefined;
  if (!ref) return { error: 'Paste a link (or a Jira issue key) first.' };
  const parsed = AddUrlAttachmentInput.safeParse(
    source === 'CONFLUENCE'
      ? { source, page: ref, title }
      : source === 'JIRA'
        ? { source, issue: ref, title }
        : { source: 'URL', url: ref, title },
  );
  if (!parsed.success) {
    return {
      error:
        source === 'URL'
          ? 'Enter a full web address starting with https:// or http://.'
          : 'Check the link and the title (at most 200 characters).',
    };
  }
  return attempt(owner, () =>
    api<AttachmentView>(`/${owner.kind}/${owner.id}/attachments`, {
      method: 'POST',
      body: parsed.data,
    }),
  );
}

export async function refreshAttachment(
  owner: AttachmentOwner,
  attachmentId: string,
  _prev: AttachmentActionState,
): Promise<AttachmentActionState> {
  if (!isOwner(owner) || !isId(attachmentId)) return INVALID;
  return attempt(owner, () =>
    api<AttachmentView>(`/attachments/${attachmentId}/refresh`, { method: 'POST' }),
  );
}

export async function deleteAttachment(
  owner: AttachmentOwner,
  attachmentId: string,
  _prev: AttachmentActionState,
): Promise<AttachmentActionState> {
  if (!isOwner(owner) || !isId(attachmentId)) return INVALID;
  return attempt(owner, () => api(`/attachments/${attachmentId}`, { method: 'DELETE' }));
}
