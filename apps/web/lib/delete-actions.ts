'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';
import { isId } from './ids';

// Deleting a Feature or a Project (ticket 0049). The API checks who may (a Feature's POs and
// Admins; Admins for a Project) and answers 404 outside the caller's Organization. On
// success the caller navigates away itself, so it can say what happened there.

export type DeleteResult = { error?: string; ok?: boolean };

async function attempt(path: string): Promise<DeleteResult> {
  try {
    await api(path, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        error: error.status === 404 ? 'It no longer exists. Reload the page.' : error.message,
      };
    }
    throw error;
  }
  // Every list that showed it (the sidebar, the Project, the Team, the Inbox).
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function deleteFeature(featureId: string): Promise<DeleteResult> {
  if (!isId(featureId)) return { error: 'That link is not valid. Reload the page.' };
  return attempt(`/features/${featureId}`);
}

export async function deleteProject(projectId: string): Promise<DeleteResult> {
  if (!isId(projectId)) return { error: 'That link is not valid. Reload the page.' };
  return attempt(`/projects/${projectId}`);
}
