'use server';

import type {
  AiSettingsInput,
  AiSettingsView,
  AiTestResult,
  LoginResult,
  SetupInput,
} from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, api } from './api';
import { setSession } from './session';

export type ActionResult = { error?: string };

const errorOf = (error: unknown) => {
  if (error instanceof ApiError) return error.message;
  throw error;
};

export async function testAiDuringSetup(input: AiSettingsInput): Promise<AiTestResult> {
  try {
    return await api<AiTestResult>('/setup/test-ai', {
      method: 'POST',
      body: input,
      redirectOnUnauthorized: false,
    });
  } catch (error) {
    return { ok: false, message: errorOf(error), latencyMs: null };
  }
}

export async function completeSetup(input: SetupInput): Promise<ActionResult> {
  let result: LoginResult;
  try {
    result = await api<LoginResult>('/setup', {
      method: 'POST',
      body: input,
      redirectOnUnauthorized: false,
    });
  } catch (error) {
    return { error: errorOf(error) };
  }
  await setSession(result);
  redirect('/inbox?welcome=1');
}

export async function testAiSettings(input: AiSettingsInput): Promise<AiTestResult> {
  try {
    return await api<AiTestResult>('/settings/ai/test', { method: 'POST', body: input });
  } catch (error) {
    return { ok: false, message: errorOf(error), latencyMs: null };
  }
}

export async function saveAiSettings(input: AiSettingsInput): Promise<ActionResult> {
  try {
    await api<AiSettingsView>('/settings/ai', { method: 'PUT', body: input });
  } catch (error) {
    return { error: errorOf(error) };
  }
  revalidatePath('/settings/ai');
  return {};
}
