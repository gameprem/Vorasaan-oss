'use server';

import { ProjectResponseWindowsInput, ResponseWindowSettingsInput } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';
import { isId } from './ids';

// Response Window settings (ticket 0055). They only forward to the API as the signed-in
// user, which checks that they are an Admin; the shared schemas give early, readable errors.

export type ResponseWindowActionState = { error?: string; ok?: boolean };

const firstIssue = (error: { issues: { message: string }[] }) =>
  error.issues[0]?.message ?? 'Check the form and try again.';

async function attempt(run: () => Promise<unknown>): Promise<ResponseWindowActionState> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath('/settings/response-windows');
  return { ok: true };
}

/** Replaces the Organization's working calendar and default windows (Admins). */
export async function saveResponseWindowSettings(
  input: ResponseWindowSettingsInput,
): Promise<ResponseWindowActionState> {
  const parsed = ResponseWindowSettingsInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt(() => api('/settings/response-windows', { method: 'PUT', body: parsed.data }));
}

/** Sets a Project's own windows; null keeps the Organization's (Admins). */
export async function saveProjectResponseWindows(
  projectId: string,
  input: ProjectResponseWindowsInput,
): Promise<ResponseWindowActionState> {
  if (!isId(projectId)) return { error: 'That link is not valid. Reload the page.' };
  const parsed = ProjectResponseWindowsInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return attempt(() =>
    api(`/projects/${projectId}/response-windows`, { method: 'PUT', body: parsed.data }),
  );
}
