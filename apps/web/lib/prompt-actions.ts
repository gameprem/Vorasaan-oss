'use server';

import type {
  CreatePromptVersionInput,
  PromptDiff,
  PromptEvalComparison,
  PromptEvalRunSummary,
  PromptEvalRunView,
  StartPromptEvalInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from './api';

// Settings → AI → Prompts (ticket 0071). The API checks that the caller is an Admin.

export type ActionResult = { error?: string };

const base = (name: string) => `/settings/ai/prompts/${encodeURIComponent(name)}`;

async function attempt(name: string, run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  revalidatePath('/settings/ai/prompts');
  revalidatePath(`/settings/ai/prompts/${name}`);
  return {};
}

/** A read that returns its error to show (as `failure`) instead of throwing. */
async function read<T>(run: () => Promise<T>): Promise<T | { failure: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) return { failure: error.message };
    throw error;
  }
}

export async function proposePromptVersion(name: string, input: CreatePromptVersionInput) {
  return attempt(name, () => api(`${base(name)}/versions`, { method: 'POST', body: input }));
}

export async function approvePromptVersion(name: string, number: number) {
  return attempt(name, () => api(`${base(name)}/versions/${number}/approve`, { method: 'POST' }));
}

export async function declinePromptVersion(name: string, number: number, reason?: string) {
  return attempt(name, () =>
    api(`${base(name)}/versions/${number}/decline`, {
      method: 'POST',
      body: reason?.trim() ? { reason } : {},
    }),
  );
}

/** Makes an approved version (or 0, the default) active again. */
export async function rollbackPrompt(name: string, version: number) {
  return attempt(name, () => api(`${base(name)}/rollback`, { method: 'POST', body: { version } }));
}

export async function promptDiff(name: string, from: number, to: number) {
  return read(() => api<PromptDiff>(`${base(name)}/diff?from=${from}&to=${to}`));
}

export async function startPromptEval(
  name: string,
  input: StartPromptEvalInput,
): Promise<ActionResult & { run?: PromptEvalRunSummary }> {
  try {
    const run = await api<PromptEvalRunSummary>(`${base(name)}/evals`, {
      method: 'POST',
      body: input,
    });
    revalidatePath(`/settings/ai/prompts/${name}`);
    return { run };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function promptEvalRun(name: string, runId: string) {
  return read(() => api<PromptEvalRunView>(`${base(name)}/evals/${runId}`));
}

export async function comparePromptRuns(name: string, a: string, b: string) {
  return read(() => api<PromptEvalComparison>(`${base(name)}/evals/compare?a=${a}&b=${b}`));
}
