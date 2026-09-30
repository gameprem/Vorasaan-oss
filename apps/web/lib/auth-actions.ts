'use server';

import type { CreatedAccessToken, LoginResult } from '@vorasaan/shared';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, api, SESSION_COOKIE } from './api';
import { setSession } from './session';

export type LoginState = { error?: string; email?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.', email };

  let result: LoginResult;
  try {
    result = await api<LoginResult>('/auth/login', {
      method: 'POST',
      body: { email, password },
      redirectOnUnauthorized: false,
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message, email };
    throw error;
  }
  await setSession(result);
  redirect('/inbox');
}

export async function logout() {
  await api('/auth/logout', { method: 'POST', redirectOnUnauthorized: false }).catch(() => {});
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

export type TokenState = { error?: string; created?: CreatedAccessToken };

export async function createAccessToken(
  _prev: TokenState,
  formData: FormData,
): Promise<TokenState> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return { error: 'Name the token, e.g. "Laptop CLI".' };
  try {
    const created = await api<CreatedAccessToken>('/me/tokens', { method: 'POST', body: { name } });
    revalidatePath('/settings/tokens');
    return { created };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function revokeAccessToken(id: string) {
  await api(`/me/tokens/${id}`, { method: 'DELETE' });
  revalidatePath('/settings/tokens');
}
