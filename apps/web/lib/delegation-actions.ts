'use server';

import { CreateDelegationInput, type DelegationView } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';
import { isId } from './ids';

// Delegation actions. They only forward to the API as the signed-in user, which decides
// who may name a Delegate for whom; the shared schema gives early, readable errors. Ids
// arrive from the browser, so they are checked to be UUIDs before they reach an API path.

export type DelegationActionState = { error?: string; ok?: boolean };

const INVALID: DelegationActionState = { error: 'That link is not valid. Reload the page.' };

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

function revalidate(teamId: string) {
  revalidatePath('/settings/delegations');
  revalidatePath(`/teams/${teamId}`);
  revalidatePath('/inbox');
}

async function attempt(teamId: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidate(teamId);
  return { ok: true };
}

/**
 * Names a Delegate. `startsAt` and `endsAt` come from the browser already converted from
 * the person's local time to ISO. `delegatorId` is only sent by an Admin naming one for
 * someone else; the API refuses it from anyone else.
 */
export async function createDelegation(
  _prev: DelegationActionState,
  formData: FormData,
): Promise<DelegationActionState> {
  const teamId = str(formData, 'teamId');
  if (!isId(teamId)) return { error: 'Pick a Team.' };
  if (!str(formData, 'role')) return { error: 'Pick the Team Role to delegate.' };
  if (!str(formData, 'delegateId')) return { error: 'Pick a Delegate.' };
  if (!str(formData, 'startsAt') || !str(formData, 'endsAt')) {
    return { error: 'Set when the Delegation starts and ends.' };
  }
  const parsed = CreateDelegationInput.safeParse({
    delegatorId: str(formData, 'delegatorId') || undefined,
    delegateId: str(formData, 'delegateId'),
    role: str(formData, 'role'),
    startsAt: str(formData, 'startsAt'),
    endsAt: str(formData, 'endsAt'),
  });
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === 'endsAt')
      ? { error: 'The Delegation must end after it starts.' }
      : { error: 'Check the Team Role, the Delegate and the dates.' };
  }
  if (new Date(parsed.data.endsAt) <= new Date()) {
    return { error: 'The end date has already passed. Pick one in the future.' };
  }
  return attempt(teamId, () =>
    api<DelegationView>(`/teams/${teamId}/delegations`, { method: 'POST', body: parsed.data }),
  );
}

export async function deleteDelegation(
  teamId: string,
  id: string,
  _prev: DelegationActionState,
): Promise<DelegationActionState> {
  if (!isId(teamId) || !isId(id)) return INVALID;
  return attempt(teamId, () => api(`/teams/${teamId}/delegations/${id}`, { method: 'DELETE' }));
}
