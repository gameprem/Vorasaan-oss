'use server';

import {
  DesignDocKey,
  type DesignDocSummary,
  type DesignDocVersionView,
  DesignTemplateKind,
  SetDesignTemplateInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';
import { isId } from './ids';

// Design Docs (ticket 0069): each action only forwards to the API as the signed-in user, which
// checks that they approve the Design Doc (a Tech Lead or a Role Owner of its Platform's Team
// Roles) or, for templates, edit the Project. Ids and keys arrive from the browser, so they
// are parsed before they become part of an API path.

export type DesignDocActionResult = { error?: string; ok?: boolean; stale?: boolean };

const INVALID: DesignDocActionResult = { error: 'That link is not valid. Reload the page.' };

const valid = (featureId: string, key: string) =>
  isId(featureId) && DesignDocKey.safeParse(key).success;

async function attempt(
  paths: string[],
  run: () => Promise<unknown>,
): Promise<DesignDocActionResult> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message, stale: error.status === 409 };
    throw error;
  }
  for (const path of paths) revalidatePath(path);
  return { ok: true };
}

const pages = (featureId: string, key: string) => [
  `/features/${featureId}`,
  `/features/${featureId}/design-docs/${key}`,
];

/** Approves the proposal's current Redraft (`redraft`, the one the approver saw). */
export async function approveDesignDoc(
  featureId: string,
  key: string,
  proposalId: string,
  redraft: number,
): Promise<DesignDocActionResult> {
  if (!valid(featureId, key) || !isId(proposalId)) return INVALID;
  return attempt(pages(featureId, key), () =>
    api<DesignDocVersionView>(`/design-doc-proposals/${proposalId}/approve`, {
      method: 'POST',
      body: Number.isInteger(redraft) && redraft > 0 ? { redraft } : {},
    }),
  );
}

export async function declineDesignDoc(
  featureId: string,
  key: string,
  proposalId: string,
  reason: string,
): Promise<DesignDocActionResult> {
  if (!valid(featureId, key) || !isId(proposalId)) return INVALID;
  const trimmed = reason.trim().slice(0, 2_000);
  return attempt(pages(featureId, key), () =>
    api(`/design-doc-proposals/${proposalId}/decline`, {
      method: 'POST',
      body: trimmed ? { reason: trimmed } : {},
    }),
  );
}

/** Asks the AI for the draft now (after a failed or declined one). */
export async function draftDesignDoc(
  featureId: string,
  key: string,
): Promise<DesignDocActionResult> {
  if (!valid(featureId, key)) return INVALID;
  return attempt(pages(featureId, key), () =>
    api<DesignDocSummary>(`/features/${featureId}/design-docs/${key}/draft`, { method: 'POST' }),
  );
}

/** Restores `version` as the next version, on top of `baseVersion` (RevertButton's action). */
export async function revertDesignDoc(
  featureId: string,
  key: string,
  version: number,
  baseVersion: number,
  _prev: DesignDocActionResult,
): Promise<DesignDocActionResult> {
  if (
    !valid(featureId, key) ||
    !Number.isSafeInteger(version) ||
    !Number.isSafeInteger(baseVersion)
  ) {
    return INVALID;
  }
  return attempt(pages(featureId, key), () =>
    api(`/features/${featureId}/design-docs/${key}/versions/${version}/revert`, {
      method: 'POST',
      body: { baseVersion },
    }),
  );
}

/** Saves a Project's own Design Doc template of one kind, or (`markdown` null) restores the built-in one. */
export async function saveDesignTemplate(
  projectId: string,
  kind: string,
  markdown: string | null,
): Promise<DesignDocActionResult> {
  const parsedKind = DesignTemplateKind.safeParse(kind);
  if (!isId(projectId) || !parsedKind.success) return INVALID;
  if (markdown === null) {
    return attempt([`/projects/${projectId}`], () =>
      api(`/projects/${projectId}/design-templates/${parsedKind.data}`, { method: 'DELETE' }),
    );
  }
  const input = SetDesignTemplateInput.safeParse({ markdown });
  if (!input.success) return { error: input.error.issues[0]?.message ?? 'Check the template.' };
  return attempt([`/projects/${projectId}`], () =>
    api(`/projects/${projectId}/design-templates/${parsedKind.data}`, {
      method: 'PUT',
      body: input.data,
    }),
  );
}
