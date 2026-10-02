'use server';

import {
  type AiSettingsInput,
  type AiTestResult,
  type LoginResult,
  SETUP_TOKEN_HEADER,
  type SetupInput,
} from '@vorasaan/shared';
import { redirect } from 'next/navigation';
import { ApiError, api } from './api';
import { setSession } from './session';

/** `tokenRejected`: the server refused the Setup Token, so the wizard asks for it again. */
export type ActionResult = { error?: string; tokenRejected?: boolean };

const errorOf = (error: unknown) => {
  if (error instanceof ApiError) return error.message;
  throw error;
};

// The Setup Token travels only in this header to the API; it is never logged.
const tokenHeader = (setupToken: string) => ({ [SETUP_TOKEN_HEADER]: setupToken.trim() });

export async function testAiDuringSetup(
  input: AiSettingsInput,
  setupToken: string,
): Promise<AiTestResult> {
  try {
    return await api<AiTestResult>('/setup/test-ai', {
      method: 'POST',
      body: input,
      headers: tokenHeader(setupToken),
      redirectOnUnauthorized: false,
      anonymous: true,
    });
  } catch (error) {
    return { ok: false, message: errorOf(error), latencyMs: null };
  }
}

export async function completeSetup(input: SetupInput, setupToken: string): Promise<ActionResult> {
  let result: LoginResult;
  try {
    result = await api<LoginResult>('/setup', {
      method: 'POST',
      body: input,
      headers: tokenHeader(setupToken),
      redirectOnUnauthorized: false,
      anonymous: true,
    });
  } catch (error) {
    return {
      error: errorOf(error),
      tokenRejected: error instanceof ApiError && (error.status === 401 || error.status === 429),
    };
  }
  await setSession(result);
  redirect('/inbox?welcome=1');
}
