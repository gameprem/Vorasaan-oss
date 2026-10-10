import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { devPages } from '@/lib/api';
import { UiGallery } from './gallery';

// The UI kit gallery (ADR 0016, ticket 0077): every component in every state, for review
// and the accessibility e2e. Dev-only, like the identity switcher: a 404 in production
// unless VORASAAN_DEV_AUTH is on.

export const metadata: Metadata = { title: 'UI kit' };

export default async function UiKitPage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string }>;
}) {
  if (!devPages()) notFound();
  const { theme } = await searchParams;
  return <UiGallery theme={theme === 'light' || theme === 'dark' ? theme : 'system'} />;
}
