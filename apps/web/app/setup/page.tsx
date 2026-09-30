import type { SetupStatus } from '@vorasaan/shared';
import { redirect } from 'next/navigation';
import { SetupWizard } from '@/components/setup-wizard';
import { api } from '@/lib/api';

export const metadata = { title: 'Set up' };

export default async function SetupPage() {
  const { needsSetup } = await api<SetupStatus>('/setup/status', {
    redirectOnUnauthorized: false,
  });
  if (!needsSetup) redirect('/login');
  return <SetupWizard />;
}
