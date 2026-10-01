import type { Metadata } from 'next';
import { Anuphan, Figtree, JetBrains_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { LiveUpdates } from '@/components/live-updates';
import { Shell, SIDEBAR_COOKIE } from '@/components/shell';
import { UserSwitcher } from '@/components/user-switcher';
import { api, currentUser, DEV_USER_COOKIE, type DevUser, devAuth } from '@/lib/api';
import { logout } from '@/lib/auth-actions';
import { loadSidebar } from '@/lib/sidebar';
import './globals.css';
import './chat.css';

// The type from ADR 0008: Figtree, with Anuphan for Thai.
const figtree = Figtree({ subsets: ['latin'], variable: '--font-figtree' });
const anuphan = Anuphan({ subsets: ['thai', 'latin'], variable: '--font-anuphan' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

export const metadata: Metadata = {
  title: { default: 'Vorasaan', template: '%s · Vorasaan' },
  description: 'Decide once. Keep the Spec true.',
};

export default async function RootLayout({
  children,
  modal,
}: {
  children: ReactNode;
  /** Settings, when opened from the app (app/@modal/(.)settings). */
  modal: ReactNode;
}) {
  const jar = await cookies();
  const me = await currentUser();
  const dev = devAuth();
  const devUsers = dev
    ? await api<DevUser[]>('/dev/users', { redirectOnUnauthorized: false, anonymous: true }).catch(
        () => [],
      )
    : [];
  const devUserId = dev ? jar.get(DEV_USER_COOKIE)?.value : undefined;
  const switcher = dev && <UserSwitcher users={devUsers} currentId={devUserId} />;

  return (
    <html lang="en" className={`${figtree.variable} ${anuphan.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh">
        {me ? (
          <Shell
            me={me}
            data={await loadSidebar()}
            initiallyCollapsed={jar.get(SIDEBAR_COOKIE)?.value === 'collapsed'}
            footer={
              <>
                {switcher && <div className="dev-only px-3.5 pt-1">{switcher}</div>}
                {!devUserId && (
                  <form action={logout} className="collapsible px-3.5">
                    <button
                      type="submit"
                      className="text-sm text-fg-soft hover:text-fg hover:underline"
                    >
                      Sign out
                    </button>
                  </form>
                )}
                <LiveUpdates />
              </>
            }
          >
            {children}
          </Shell>
        ) : (
          // Signing in, setting up or accepting an invitation: no Sidebar yet.
          <>
            {switcher && <header className="flex justify-end px-4 py-3">{switcher}</header>}
            <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">{children}</main>
          </>
        )}
        {modal}
      </body>
    </html>
  );
}
