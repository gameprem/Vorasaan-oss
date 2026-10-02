'use server';

import type {
  CreatedInvitation,
  LoginResult,
  SetRoleOwnersInput,
  TeamRole,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, api } from './api';
import { setSession } from './session';

export type FormState = { error?: string; ok?: boolean };

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

async function attempt(run: () => Promise<unknown>, path?: string): Promise<FormState> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  if (path) revalidatePath(path);
  return { ok: true };
}

export async function createProject(_prev: FormState, formData: FormData) {
  return attempt(
    () =>
      api('/projects', {
        method: 'POST',
        body: { name: str(formData, 'name'), jiraKey: str(formData, 'jiraKey') },
      }),
    '/projects',
  );
}

export async function createTeam(projectId: string, _prev: FormState, formData: FormData) {
  return attempt(
    () =>
      api(`/projects/${projectId}/teams`, {
        method: 'POST',
        body: { name: str(formData, 'name') },
      }),
    '/projects',
  );
}

export async function setTeamRoles(teamId: string, userId: string, roles: TeamRole[]) {
  return attempt(
    () => api(`/teams/${teamId}/members/${userId}`, { method: 'PUT', body: { roles } }),
    `/teams/${teamId}`,
  );
}

export async function createFeature(teamId: string, _prev: FormState, formData: FormData) {
  let id: string | undefined;
  const result = await attempt(async () => {
    const feature = await api<{ id: string }>(`/teams/${teamId}/features`, {
      method: 'POST',
      body: {
        title: str(formData, 'title'),
        description: str(formData, 'description') || undefined,
        jiraIssueKey: str(formData, 'jiraIssueKey'),
      },
    });
    id = feature.id;
  });
  if (result.error || !id) return result;
  redirect(`/features/${id}?tab=team`);
}

export type InviteState = FormState & { created?: CreatedInvitation };

export async function invite(_prev: InviteState, formData: FormData): Promise<InviteState> {
  try {
    const created = await api<CreatedInvitation>('/invitations', {
      method: 'POST',
      body: { email: str(formData, 'email'), role: str(formData, 'role') || 'MEMBER' },
    });
    revalidatePath('/settings/members');
    return { ok: true, created };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function revokeInvitation(id: string) {
  await api(`/invitations/${id}`, { method: 'DELETE' });
  revalidatePath('/settings/members');
}

export async function acceptInvitation(token: string, _prev: FormState, formData: FormData) {
  let result: LoginResult;
  try {
    result = await api<LoginResult>(`/invite/${token}`, {
      method: 'POST',
      body: { name: str(formData, 'name'), password: String(formData.get('password') ?? '') },
      redirectOnUnauthorized: false,
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  await setSession(result);
  redirect('/inbox');
}

export async function setRoleOwners(featureId: string, input: SetRoleOwnersInput) {
  return attempt(
    () => api(`/features/${featureId}/role-owners`, { method: 'PUT', body: input }),
    `/features/${featureId}`,
  );
}
