'use server';

import { OrganizationSettingsInput } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';

// After first-run setup (ticket 0063). They only forward to the API as the signed-in user,
// which checks that they are an Admin.

export type ActionState = { error?: string; ok?: boolean };

/** Sets the Organization's default language (Admins). */
export async function saveOrganizationSettings(
  input: OrganizationSettingsInput,
): Promise<ActionState> {
  const parsed = OrganizationSettingsInput.safeParse(input);
  if (!parsed.success) return { error: 'Pick English or Thai.' };
  try {
    await api('/settings/organization', { method: 'PUT', body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath('/settings/organization');
  return { ok: true };
}

/** Hides the Getting started checklist for the signed-in Admin, for good. */
export async function dismissGettingStarted(): Promise<ActionState> {
  try {
    await api('/me/getting-started/dismiss', { method: 'POST' });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath('/inbox');
  return { ok: true };
}
