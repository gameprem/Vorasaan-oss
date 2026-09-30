'use server';

import {
  AddUrlAttachmentInput,
  type AttachmentView,
  type SpecProposalView,
  type SpecVersionView,
  WriteSpecInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, api } from './api';
import { isId } from './ids';

// Feature page actions: the Spec, its history and the Feature's Attachments. Each one only
// forwards to the API as the signed-in user, which enforces who may do what. Ids arrive from
// the browser, so they are checked to be UUIDs before they become part of an API path.

export type FeatureActionState = { error?: string; ok?: boolean; stale?: boolean };

const INVALID: FeatureActionState = { error: 'That link is not valid. Reload the page.' };

async function attempt(featureId: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.message, stale: error.status === 409 } satisfies FeatureActionState;
    }
    throw error;
  }
  revalidatePath(`/features/${featureId}`);
  return { ok: true } satisfies FeatureActionState;
}

/** Saves the editor's Markdown as the next Spec Version. 409 means someone saved first. */
export async function saveSpec(
  featureId: string,
  input: WriteSpecInput,
): Promise<FeatureActionState> {
  if (!isId(featureId)) return INVALID;
  const parsed = WriteSpecInput.safeParse(input);
  if (!parsed.success) return { error: 'The Spec is empty. Write something before saving.' };
  return attempt(featureId, () =>
    api<SpecVersionView>(`/features/${featureId}/spec-versions`, {
      method: 'POST',
      body: parsed.data,
    }),
  );
}

/** Restores `version` as a new Spec Version on top of `baseVersion`. */
export async function revertSpec(
  featureId: string,
  version: number,
  baseVersion: number,
  _prev: FeatureActionState,
): Promise<FeatureActionState> {
  if (!isId(featureId) || !Number.isSafeInteger(version) || !Number.isSafeInteger(baseVersion)) {
    return INVALID;
  }
  const result = await attempt(featureId, () =>
    api<SpecVersionView>(`/features/${featureId}/spec-versions/${version}/revert`, {
      method: 'POST',
      body: { baseVersion },
    }),
  );
  if (result.error) return result;
  redirect(`/features/${featureId}?tab=history`);
}

/** Attaches a public web page, a Confluence page or a Jira issue. */
export async function addLinkAttachment(
  featureId: string,
  _prev: FeatureActionState,
  formData: FormData,
): Promise<FeatureActionState> {
  if (!isId(featureId)) return INVALID;
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
  return attempt(featureId, () =>
    api<AttachmentView>(`/features/${featureId}/attachments`, {
      method: 'POST',
      body: parsed.data,
    }),
  );
}

export async function refreshAttachment(
  featureId: string,
  attachmentId: string,
  _prev: FeatureActionState,
): Promise<FeatureActionState> {
  if (!isId(featureId) || !isId(attachmentId)) return INVALID;
  return attempt(featureId, () =>
    api<AttachmentView>(`/attachments/${attachmentId}/refresh`, { method: 'POST' }),
  );
}

export async function deleteAttachment(
  featureId: string,
  attachmentId: string,
  _prev: FeatureActionState,
): Promise<FeatureActionState> {
  if (!isId(featureId) || !isId(attachmentId)) return INVALID;
  return attempt(featureId, () => api(`/attachments/${attachmentId}`, { method: 'DELETE' }));
}

/** Asks the AI for a Spec Proposal from the Attachments, then opens its review. */
export async function draftSpecFromAttachments(
  featureId: string,
  _prev: FeatureActionState,
): Promise<FeatureActionState> {
  if (!isId(featureId)) return INVALID;
  let proposal: SpecProposalView;
  try {
    proposal = await api<SpecProposalView>(
      `/features/${featureId}/spec-proposals/from-attachments`,
      { method: 'POST' },
    );
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  redirect(`/features/${featureId}/proposals/${proposal.id}`);
}
