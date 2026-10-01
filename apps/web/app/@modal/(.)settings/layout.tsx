import type { ReactNode } from 'react';
import { SettingsDialog } from '@/components/settings-dialog';

// Settings opened from the app (a soft navigation to /settings/...): intercepted into the
// modal slot, over the page you came from.
export default function SettingsOverlayLayout({ children }: { children: ReactNode }) {
  return <SettingsDialog mode="overlay">{children}</SettingsDialog>;
}
