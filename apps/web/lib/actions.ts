'use server';

import type { DecideResult, SpecProposalView, SpecVersionView } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, api, DEV_USER_COOKIE } from './api';

export type ActionState = { error?: string };

export async function switchUser(formData: FormData) {
  const id = String(formData.get('userId') ?? '');
  const jar = await cookies();
  if (id) jar.set(DEV_USER_COOKIE, id, { path: '/', sameSite: 'lax' });
  else jar.delete(DEV_USER_COOKIE);
  revalidatePath('/', 'layout');
}

export async function decide(
  requestId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const choice = String(formData.get('choice') ?? '');
  const customAnswer = String(formData.get('customAnswer') ?? '').trim();
  const rationale = String(formData.get('rationale') ?? '').trim() || undefined;

  if (!choice) return { error: 'Pick one of the Choices, or answer in your own words.' };
  if (choice === 'custom' && !customAnswer) return { error: 'Write your answer before deciding.' };

  try {
    await api<DecideResult>(`/decision-requests/${requestId}/decision`, {
      method: 'POST',
      body: choice === 'custom' ? { customAnswer, rationale } : { choiceId: choice, rationale },
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/requests/${requestId}`);
  return {};
}

export async function approveProposal(
  proposalId: string,
  requestId: string,
  _prev: ActionState,
): Promise<ActionState> {
  let version: SpecVersionView;
  try {
    version = await api<SpecVersionView>(`/spec-proposals/${proposalId}/approve`, {
      method: 'POST',
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/requests/${requestId}`);
  redirect(`/features/${version.featureId}?approved=${version.version}`);
}

export async function rejectProposal(
  proposalId: string,
  requestId: string,
  _prev: ActionState,
): Promise<ActionState> {
  try {
    await api<SpecProposalView>(`/spec-proposals/${proposalId}/reject`, { method: 'POST' });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/requests/${requestId}`);
  return {};
}
