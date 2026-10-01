import type { ConversationView } from '@vorasaan/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { relativeTime } from '@/components/bits';
import { ApiError, api } from '@/lib/api';
import { isId } from '@/lib/ids';

async function load(id: string) {
  if (!isId(id)) notFound();
  try {
    return await api<ConversationView>(`/conversations/${id}`);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: (await load(id)).title };
}

// A placeholder that the chat view (ticket 0046) replaces: it names the Conversation and
// where it belongs, so the Sidebar's recent Conversations lead somewhere real.
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conversation = await load(id);
  const { scope } = conversation;
  const people = conversation.messages.filter((m) => m.role === 'USER').length;

  return (
    <section className="mx-auto max-w-[780px]">
      <p className="text-fg-soft">
        <Link href={`/projects/${scope.project.id}`} className="hover:text-fg hover:underline">
          {scope.project.name}
        </Link>
        {scope.kind === 'FEATURE' && (
          <>
            {' › '}
            <Link href={`/features/${scope.feature.id}`} className="hover:text-fg hover:underline">
              {scope.feature.title}
            </Link>
          </>
        )}
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{conversation.title}</h1>
      <p className="mt-2 text-sm text-fg-soft">
        {people} message{people === 1 ? '' : 's'} from you · last active{' '}
        {relativeTime(conversation.updatedAt)}
      </p>
      <p className="mt-8 rounded-card bg-rail px-5 py-4 text-fg-soft">
        The chat view for this Conversation is coming. Its messages and Action Cards are kept, and
        will show here.
      </p>
    </section>
  );
}
