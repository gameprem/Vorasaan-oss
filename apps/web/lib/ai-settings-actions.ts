'use server';

import type {
  AiTestResult,
  CreateAiProviderInput,
  CreateApprovedModelInput,
  ProviderModelsView,
  ReceiptSettingsInput,
  SetAiTaskModelsInput,
  UpdateAiProviderInput,
  UpdateApprovedModelInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';

// Settings → AI models. The API checks that the caller is an Admin.

export type ActionResult = { error?: string };

const PATH = '/settings/ai';

async function attempt(run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath(PATH);
  return {};
}

export async function createAiProvider(input: CreateAiProviderInput) {
  return attempt(() => api('/settings/ai/providers', { method: 'POST', body: input }));
}

export async function updateAiProvider(id: string, input: UpdateAiProviderInput) {
  return attempt(() => api(`/settings/ai/providers/${id}`, { method: 'PATCH', body: input }));
}

export async function deleteAiProvider(id: string) {
  return attempt(() => api(`/settings/ai/providers/${id}`, { method: 'DELETE' }));
}

export async function createApprovedModel(input: CreateApprovedModelInput) {
  return attempt(() => api('/settings/ai/models', { method: 'POST', body: input }));
}

export async function updateApprovedModel(id: string, input: UpdateApprovedModelInput) {
  return attempt(() => api(`/settings/ai/models/${id}`, { method: 'PATCH', body: input }));
}

export async function deleteApprovedModel(id: string) {
  return attempt(() => api(`/settings/ai/models/${id}`, { method: 'DELETE' }));
}

export async function testApprovedModel(id: string): Promise<AiTestResult> {
  try {
    return await api<AiTestResult>(`/settings/ai/models/${id}/test`, { method: 'POST' });
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message, latencyMs: null };
    throw error;
  }
}

export async function setAiTaskModels(input: SetAiTaskModelsInput) {
  return attempt(() => api('/settings/ai/tasks', { method: 'PUT', body: input }));
}

/**
 * The model list of an OpenRouter or Gemini provider (tickets 0064, 0080); an error to
 * show otherwise.
 */
export async function listProviderModels(providerId: string): Promise<ProviderModelsView> {
  try {
    return await api<ProviderModelsView>(`/settings/ai/providers/${providerId}/models`);
  } catch (error) {
    if (error instanceof ApiError) return { models: [], error: error.message };
    throw error;
  }
}

/** Receipts (ticket 0070): collection on or off, and how many days they are kept. */
export async function saveReceiptSettings(input: ReceiptSettingsInput) {
  return attempt(() => api('/settings/ai/receipts', { method: 'PUT', body: input }));
}
