'use server';

import type { DecideResult, SpecProposalView, SpecVersionView } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, api, DEV_USER_COOKIE } from './api';
import { isId } from './ids';

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

/** `requestId` is the Decision Request the Proposal came from, or null (e.g. drafted from Attachments). */
export async function approveProposal(
  proposalId: string,
  requestId: string | null,
  /** The Redraft the approver saw (ticket 0065): nothing is approved if another is current. */
  redraft: number | null,
  _prev: ActionState,
): Promise<ActionState> {
  if (!isId(proposalId) || (requestId !== null && !isId(requestId))) {
    return { error: 'That link is not valid. Reload the page.' };
  }
  let version: SpecVersionView;
  try {
    version = await api<SpecVersionView>(`/spec-proposals/${proposalId}/approve`, {
      method: 'POST',
      ...(redraft && Number.isInteger(redraft) && redraft > 0 ? { body: { redraft } } : {}),
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  if (requestId) revalidatePath(`/requests/${requestId}`);
  redirect(`/features/${version.featureId}?approved=${version.version}`);
}

export async function rejectProposal(
  proposalId: string,
  requestId: string | null,
  _prev: ActionState,
): Promise<ActionState> {
  if (!isId(proposalId) || (requestId !== null && !isId(requestId))) {
    return { error: 'That link is not valid. Reload the page.' };
  }
  let proposal: SpecProposalView;
  try {
    proposal = await api<SpecProposalView>(`/spec-proposals/${proposalId}/reject`, {
      method: 'POST',
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(
    requestId
      ? `/requests/${requestId}`
      : `/features/${proposal.featureId}/proposals/${proposalId}`,
  );
  return {};
}
