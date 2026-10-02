'use server';

import {
  AcceptFeatureSuggestionInput,
  type AcceptFeatureSuggestionResult,
  AnswerGrillingQuestionInput,
  type BriefProposalView,
  type BriefVersionView,
  DismissFeatureSuggestionInput,
  FeatureFitInput,
  type FeatureFitView,
  type FeatureSuggestionView,
  GrillingRoundKind,
  type GrillingView,
  MAX_FEATURE_SUGGESTIONS,
  OrgFeatureGuidelinesInput,
  ProjectFeatureGuidelinesInput,
  WriteBriefInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, api } from './api';
import { isId } from './ids';

// Project page actions: the Project Brief, Grilling, Feature Guidelines and Feature
// Suggestions. Each one only forwards to the API as the signed-in user, which enforces who
// may do what. Ids arrive from the browser, so they are checked to be UUIDs before they
// become part of an API path, and bodies are parsed with the shared Zod contracts.

export type ProjectActionState = { error?: string; ok?: boolean; stale?: boolean };

const INVALID: ProjectActionState = { error: 'That link is not valid. Reload the page.' };

const projectPath = (projectId: string) => `/projects/${projectId}`;

async function attempt(paths: string[], run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.message, stale: error.status === 409 } satisfies ProjectActionState;
    }
    throw error;
  }
  for (const path of paths) revalidatePath(path);
  return { ok: true } satisfies ProjectActionState;
}

const firstIssue = (error: { issues: { message: string }[] }) =>
  error.issues[0]?.message ?? 'Check the form and try again.';

// ─── Project Brief ────────────────────────────────────────────────────────

/** Saves the editor's Markdown as the next Brief Version. 409 means someone saved first. */
export async function saveBrief(
  projectId: string,
  input: WriteBriefInput,
): Promise<ProjectActionState> {
  if (!isId(projectId)) return INVALID;
  const parsed = WriteBriefInput.safeParse(input);
  if (!parsed.success) return { error: 'The Project Brief is empty. Write something first.' };
  return attempt([projectPath(projectId)], () =>
    api<BriefVersionView>(`/projects/${projectId}/brief-versions`, {
      method: 'POST',
      body: parsed.data,
    }),
  );
}

/** Restores `version` as a new Brief Version on top of `baseVersion`. */
export async function revertBrief(
  projectId: string,
  version: number,
  baseVersion: number,
  _prev: ProjectActionState,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !Number.isSafeInteger(version) || !Number.isSafeInteger(baseVersion)) {
    return INVALID;
  }
  const result = await attempt([projectPath(projectId)], () =>
    api<BriefVersionView>(`/projects/${projectId}/brief-versions/${version}/revert`, {
      method: 'POST',
      body: { baseVersion },
    }),
  );
  if (result.error) return result;
  redirect(`${projectPath(projectId)}?tab=history`);
}

export async function approveBriefProposal(
  projectId: string,
  proposalId: string,
  _prev: ProjectActionState,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !isId(proposalId)) return INVALID;
  let version: BriefVersionView;
  try {
    version = await api<BriefVersionView>(`/brief-proposals/${proposalId}/approve`, {
      method: 'POST',
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  redirect(`${projectPath(version.projectId)}?approved=${version.version}`);
}

export async function rejectBriefProposal(
  projectId: string,
  proposalId: string,
  _prev: ProjectActionState,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !isId(proposalId)) return INVALID;
  return attempt([projectPath(projectId)], () =>
    api<BriefProposalView>(`/brief-proposals/${proposalId}/reject`, { method: 'POST' }),
  );
}

// ─── Grilling ─────────────────────────────────────────────────────────────

export async function startGrilling(
  projectId: string,
  _prev: ProjectActionState,
): Promise<ProjectActionState> {
  if (!isId(projectId)) return INVALID;
  return attempt([projectPath(projectId), '/inbox'], () =>
    api<GrillingView>(`/projects/${projectId}/grillings`, { method: 'POST' }),
  );
}

export async function answerGrillingQuestion(
  projectId: string,
  grillingId: string,
  questionId: string,
  _prev: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !isId(grillingId) || !isId(questionId)) return INVALID;
  const parsed = AnswerGrillingQuestionInput.safeParse({ answer: formData.get('answer') ?? '' });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt([projectPath(projectId), '/inbox'], () =>
    api<GrillingView>(`/grillings/${grillingId}/questions/${questionId}/answer`, {
      method: 'POST',
      body: parsed.data,
    }),
  );
}

/** Skips `round`, which must still be the current one (so a stale page can't skip the next). */
export async function skipGrillingRound(
  projectId: string,
  grillingId: string,
  round: GrillingRoundKind,
  _prev: ProjectActionState,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !isId(grillingId) || !GrillingRoundKind.safeParse(round).success) {
    return INVALID;
  }
  return attempt([projectPath(projectId), '/inbox'], () =>
    api<GrillingView>(`/grillings/${grillingId}/skip-round`, { method: 'POST', body: { round } }),
  );
}

export async function cancelGrilling(
  projectId: string,
  grillingId: string,
  _prev: ProjectActionState,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !isId(grillingId)) return INVALID;
  return attempt([projectPath(projectId), '/inbox'], () =>
    api<GrillingView>(`/grillings/${grillingId}/cancel`, { method: 'POST' }),
  );
}

// ─── Feature Guidelines ───────────────────────────────────────────────────

/** Replaces the Organization default list (Admins). */
export async function saveOrgGuidelines(
  input: OrgFeatureGuidelinesInput,
): Promise<ProjectActionState> {
  const parsed = OrgFeatureGuidelinesInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt(['/settings/feature-guidelines'], () =>
    api('/settings/feature-guidelines', { method: 'PUT', body: parsed.data }),
  );
}

/** Replaces all of a Project's overrides (its POs and Admins). */
export async function saveProjectGuidelines(
  projectId: string,
  input: ProjectFeatureGuidelinesInput,
): Promise<ProjectActionState> {
  if (!isId(projectId)) return INVALID;
  const parsed = ProjectFeatureGuidelinesInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt([projectPath(projectId)], () =>
    api(`/projects/${projectId}/feature-guidelines`, { method: 'PUT', body: parsed.data }),
  );
}

export type FeatureFitState = { error?: string; fit?: FeatureFitView };

/** Checks a Feature about to be created against the effective Feature Guidelines; writes nothing. */
export async function checkFeatureFit(
  projectId: string,
  input: FeatureFitInput,
): Promise<FeatureFitState> {
  if (!isId(projectId)) return INVALID;
  const parsed = FeatureFitInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  try {
    const fit = await api<FeatureFitView>(`/projects/${projectId}/feature-fit`, {
      method: 'POST',
      body: parsed.data,
    });
    return { fit };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

// ─── Feature Suggestions ──────────────────────────────────────────────────

export async function generateSuggestions(
  projectId: string,
  _prev: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  if (!isId(projectId)) return INVALID;
  const count = Number(formData.get('count'));
  if (!Number.isInteger(count) || count < 1 || count > MAX_FEATURE_SUGGESTIONS) {
    return { error: `Ask for between 1 and ${MAX_FEATURE_SUGGESTIONS} Feature Suggestions.` };
  }
  return attempt([projectPath(projectId)], () =>
    api<FeatureSuggestionView[]>(`/projects/${projectId}/feature-suggestions/generate`, {
      method: 'POST',
      body: { count },
    }),
  );
}

/** Accepts into the chosen Team, then opens the new Feature's Spec Proposal for review. */
export async function acceptSuggestion(
  projectId: string,
  suggestionId: string,
  _prev: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !isId(suggestionId)) return INVALID;
  const parsed = AcceptFeatureSuggestionInput.safeParse({ teamId: formData.get('teamId') });
  if (!parsed.success) return { error: 'Pick the Team the Feature goes to.' };
  let result: AcceptFeatureSuggestionResult;
  try {
    result = await api<AcceptFeatureSuggestionResult>(
      `/feature-suggestions/${suggestionId}/accept`,
      { method: 'POST', body: parsed.data },
    );
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(projectPath(projectId));
  redirect(`/features/${result.feature.id}/proposals/${result.proposal.id}`);
}

export async function dismissSuggestion(
  projectId: string,
  suggestionId: string,
  _prev: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  if (!isId(projectId) || !isId(suggestionId)) return INVALID;
  const parsed = DismissFeatureSuggestionInput.safeParse({ reason: formData.get('reason') ?? '' });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt([projectPath(projectId)], () =>
    api<FeatureSuggestionView>(`/feature-suggestions/${suggestionId}/dismiss`, {
      method: 'POST',
      body: parsed.data,
    }),
  );
}
