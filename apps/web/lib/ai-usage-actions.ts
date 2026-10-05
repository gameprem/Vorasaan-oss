'use server';

import type { AiBudgetInput, ModelPrices } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';

// Settings → AI usage (ticket 0075): the monthly budget and the price of each Approved
// Model. The API checks that the caller is an Admin.

export type ActionResult = { error?: string };

async function attempt(run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath('/settings/ai/usage');
  revalidatePath('/settings/ai');
  return {};
}

export async function saveAiBudget(input: AiBudgetInput) {
  return attempt(() => api('/settings/ai/usage/budget', { method: 'PUT', body: input }));
}

export async function saveModelPrices(modelId: string, prices: ModelPrices | null) {
  return attempt(() =>
    api(`/settings/ai/models/${modelId}`, { method: 'PATCH', body: { prices } }),
  );
}
