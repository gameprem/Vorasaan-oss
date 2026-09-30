import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans_Thai } from 'next/font/google';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { UserSwitcher } from '@/components/user-switcher';
import { api, currentUser, DEV_USER_COOKIE, type DevUser, devAuth } from '@/lib/api';
import { logout } from '@/lib/auth-actions';
import './globals.css';

const plexThai = IBM_Plex_Sans_Thai({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-thai',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: { default: 'Vorasaan', template: '%s · Vorasaan' },
  description: 'Decide once. Keep the Spec true.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await currentUser();
  const dev = devAuth();
  const devUsers = dev
    ? await api<DevUser[]>('/dev/users', { redirectOnUnauthorized: false }).catch(() => [])
    : [];
  const devUserId = dev ? (await cookies()).get(DEV_USER_COOKIE)?.value : undefined;

  return (
    <html lang="en" className={`${plexThai.variable} ${plexMono.variable}`}>
      <body className="min-h-dvh">
        <header className="border-b border-rule bg-sheet">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 sm:px-6">
            <Link href="/inbox" className="flex items-baseline gap-2 text-ink no-underline">
              <span className="text-lg font-semibold tracking-tight">Vorasaan</span>
              <span className="text-sm text-ink-soft" lang="th">
                วรสาร
              </span>
            </Link>
            {me && (
              <nav className="flex gap-5 text-sm">
                <Link href="/inbox" className="text-ink-soft hover:text-ink">
                  Inbox
                </Link>
                <Link href="/settings/ai" className="text-ink-soft hover:text-ink">
                  AI provider
                </Link>
                <Link href="/settings/tokens" className="text-ink-soft hover:text-ink">
                  Access tokens
                </Link>
              </nav>
            )}
            <div className="ml-auto flex items-center gap-4 text-sm">
              {dev && <UserSwitcher users={devUsers} currentId={devUserId} />}
              {me && !devUserId && (
                <>
                  <span className="text-ink-soft">{me.name}</span>
                  <form action={logout}>
                    <button type="submit" className="text-ink-soft hover:text-ink">
                      Sign out
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
