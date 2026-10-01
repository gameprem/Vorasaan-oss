import Link from 'next/link';
import { currentUser } from '@/lib/api';

export const metadata = { title: 'New conversation' };

// A placeholder until the chat view (ticket 0046) brings the composer and starter cards.
export default async function NewConversationPage() {
  const me = await currentUser();
  const name = me?.name.split(' ')[0];
  return (
    <section className="mx-auto mt-[6vh] grid max-w-[780px] gap-7">
      <h1 className="text-[clamp(32px,5vw,46px)] leading-[1.15] font-semibold tracking-tight text-balance">
        <span className="grad" lang="th">
          สวัสดี{name ? ` ${name}` : ''}
        </span>
        <span className="block text-fg-faint">What should we work on today?</span>
      </h1>
      <p className="max-w-[62ch] text-fg-soft">
        Conversations with the AI open here soon. Until then, pick a Project or a Feature in the
        Sidebar, or see what waits for you in your{' '}
        <Link href="/inbox" className="text-ink underline underline-offset-2">
          Inbox
        </Link>
        .
      </p>
    </section>
  );
}
