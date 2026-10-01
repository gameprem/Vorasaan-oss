'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { SettingsDialog } from '@/components/settings-dialog';

// Settings opened from the app (a soft navigation to /settings/...): intercepted into the
// modal slot, over the page you came from.
//
// On a soft navigation out of Settings (a link inside it) the slot keeps its last page,
// since nothing else in @modal matches the new URL; the modal closes here instead. (A
// catch-all page in @modal did this before, but it made every unknown URL a 200.)
export default function SettingsOverlayLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname !== '/settings' && !pathname.startsWith('/settings/')) return null;
  return <SettingsDialog mode="overlay">{children}</SettingsDialog>;
}
