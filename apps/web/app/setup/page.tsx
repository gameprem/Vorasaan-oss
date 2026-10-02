import type { SetupStatus } from '@vorasaan/shared';
import { redirect } from 'next/navigation';
import { SetupWizard } from '@/components/setup-wizard';
import { api } from '@/lib/api';

// The Setup Token may arrive in the URL (?token=…, the link the server prints), so this
// page never sends a Referer that could carry it elsewhere.
export const metadata = { title: 'Set up', referrer: 'no-referrer' };

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { needsSetup } = await api<SetupStatus>('/setup/status', {
    redirectOnUnauthorized: false,
    anonymous: true,
  });
  if (!needsSetup) redirect('/login');
  const { token } = await searchParams;
  return <SetupWizard initialToken={typeof token === 'string' ? token.trim() : ''} />;
}
