'use server';

import {
  DraftAcceptanceCriteriaInput,
  PlatformTemplateInput,
  ProjectPlatformsInput,
  type SpecProposalView,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';
import { isId } from './ids';

// Platforms and Coverage (ADR 0009, ticket 0052): the Organization's Platform template, a
// Project's Platforms, and drafting a Platform's acceptance criteria. Each only forwards to
// the API as the signed-in user, which checks who may do it; bodies are parsed with the
// shared Zod contracts first, so a mistake is named before a round trip.

export type PlatformActionState = { error?: string; ok?: boolean };

const INVALID: PlatformActionState = { error: 'That link is not valid. Reload the page.' };

const firstIssue = (error: { issues: { message: string }[] }) =>
  error.issues[0]?.message ?? 'Check the Platforms and try again.';

async function attempt(paths: string[], run: () => Promise<unknown>): Promise<PlatformActionState> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  for (const path of paths) revalidatePath(path);
  return { ok: true };
}

/** Settings → Platforms: replaces the Organization's Platform template (Admins). */
export async function savePlatformTemplate(input: unknown): Promise<PlatformActionState> {
  const parsed = PlatformTemplateInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt(['/settings/platforms'], () =>
    api('/settings/platform-template', { method: 'PUT', body: parsed.data }),
  );
}

/**
 * A Project's Platforms tab: replaces its whole ordered list (its POs and Admins). Removing a
 * Platform that Features target is refused, and the message names those Features.
 */
export async function saveProjectPlatforms(
  projectId: string,
  input: unknown,
): Promise<PlatformActionState> {
  if (!isId(projectId)) return INVALID;
  const parsed = ProjectPlatformsInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt([`/projects/${projectId}`], () =>
    api(`/projects/${projectId}/platforms`, { method: 'PUT', body: parsed.data }),
  );
}

export type DraftCriteriaState = PlatformActionState & { proposalId?: string };

/**
 * "Draft acceptance criteria" next to a Platform missing QA: the AI drafts them as a Spec
 * Proposal the Feature's PO (or an Admin) approves (ticket 0051).
 */
export async function draftAcceptanceCriteria(
  featureId: string,
  platformId: string,
): Promise<DraftCriteriaState> {
  if (!isId(featureId)) return INVALID;
  const parsed = DraftAcceptanceCriteriaInput.safeParse({ platformId });
  if (!parsed.success) return INVALID;
  try {
    const proposal = await api<SpecProposalView>(
      `/features/${featureId}/coverage/acceptance-criteria`,
      { method: 'POST', body: parsed.data },
    );
    revalidatePath(`/features/${featureId}`);
    return { ok: true, proposalId: proposal.id };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}
