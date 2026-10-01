'use server';

import type { AiSettingsInput, AiTestResult, LoginResult, SetupInput } from '@vorasaan/shared';
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
