'use server';

import {
  type DecisionRequestView,
  PostRequestMessageInput,
  RaiseDecisionRequestInput,
  ReassignInput,
  SubmitDecisionRequestInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, api } from './api';

// Decision Request actions. Each one only forwards to the API as the signed-in user,
// which enforces who may do what; the shared schemas give early, readable errors.

export type RequestActionState = { error?: string; ok?: boolean };

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

function draftIssue(error: { issues: { path: PropertyKey[] }[] }) {
  return error.issues.some((i) => i.path[0] === 'choices')
    ? 'Keep two to four Choices, each with a title, a description and its impact on scope, time and risk.'
    : 'Pick the decider role and who to send it to.';
}

async function call(requestId: string, path: string, body?: unknown): Promise<RequestActionState> {
  try {
    await api<DecisionRequestView>(`/decision-requests/${requestId}${path}`, {
      method: 'POST',
      body,
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

export async function raiseRequest(
  featureId: string,
  _prev: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const kind = str(formData, 'kind');
  const parsed = RaiseDecisionRequestInput.safeParse({
    featureId,
    kind,
    title: str(formData, 'title'),
    description: str(formData, 'description'),
    // Only a Question may be asked as plain text, without Choices.
    withChoices: kind !== 'QUESTION' || formData.get('plainText') !== 'on',
  });
  if (!parsed.success) {
    return { error: kind ? 'Give it a title and a description.' : 'Pick Blocker or Question.' };
  }

  let created: DecisionRequestView;
  try {
    created = await api<DecisionRequestView>('/decision-requests', {
      method: 'POST',
      body: parsed.data,
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  redirect(`/requests/${created.id}`);
}

export async function submitDraft(
  requestId: string,
  _prev: RequestActionState,
  input: SubmitDecisionRequestInput,
): Promise<RequestActionState> {
  const parsed = SubmitDecisionRequestInput.safeParse(input);
  if (!parsed.success) return { error: draftIssue(parsed.error) };
  return call(requestId, '/submit', parsed.data);
}

export async function claimRequest(requestId: string): Promise<RequestActionState> {
  return call(requestId, '/claim');
}

export async function reassignRequest(
  requestId: string,
  _prev: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const parsed = ReassignInput.safeParse({ userId: str(formData, 'userId') });
  if (!parsed.success) return { error: 'Pick who should decide instead.' };
  return call(requestId, '/reassign', parsed.data);
}

export async function postRequestMessage(
  requestId: string,
  kind: PostRequestMessageInput['kind'],
  _prev: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const parsed = PostRequestMessageInput.safeParse({ kind, body: str(formData, 'body') });
  if (!parsed.success) return { error: 'Write something first.' };
  return call(requestId, '/messages', parsed.data);
}

export async function withdrawRequest(requestId: string): Promise<RequestActionState> {
  return call(requestId, '/withdraw');
}
