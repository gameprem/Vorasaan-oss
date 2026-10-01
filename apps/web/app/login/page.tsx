import type { SetupStatus } from '@vorasaan/shared';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { api, currentUser } from '@/lib/api';

export const metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const { needsSetup } = await api<SetupStatus>('/setup/status', {
    redirectOnUnauthorized: false,
    anonymous: true,
  });
  if (needsSetup) redirect('/setup');
  if (await currentUser()) redirect('/inbox');
  return (
    <div className="mx-auto max-w-sm pt-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to Vorasaan</h1>
      <p className="mt-1 text-fg-soft">Decisions waiting for you are one step away.</p>
      <LoginForm />
    </div>
  );
}
