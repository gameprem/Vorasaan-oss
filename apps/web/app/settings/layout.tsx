import type { ReactNode } from 'react';
import { SettingsDialog } from '@/components/settings-dialog';

// Settings opened by a link or a reload: the same full-screen modal, over the default view.
export default function SettingsPageLayout({ children }: { children: ReactNode }) {
  return <SettingsDialog mode="page">{children}</SettingsDialog>;
}
