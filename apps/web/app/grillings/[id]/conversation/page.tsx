import type { ConversationView, GrillingView } from '@vorasaan/shared';
import { notFound, redirect } from 'next/navigation';
import { Notice } from '@/components/bits';
import { ApiError, api } from '@/lib/api';
import { isId } from '@/lib/ids';

export const metadata = { title: 'Grilling' };

// Opens the visitor's Grilling Conversation for the round being asked (ticket 0047), for an
// "Answer Grilling" Inbox Item or starter whose person has none yet (they joined the Team
// after the round started, or deleted theirs). `POST /grillings/:id/conversation` is
// idempotent, so a second visit lands on the same Conversation. Links here don't prefetch.
export default async function OpenGrillingConversation({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isId(id)) notFound();
  let conversationId: string | null = null;
  let problem: string | null = null;
  try {
    const opened = await api<ConversationView>(`/grillings/${id}/conversation`, {
      method: 'POST',
    });
    conversationId = opened.id;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 404) notFound();
    problem = error.message;
  }
  if (conversationId) redirect(`/conversations/${conversationId}`);

  // 403 (not a holder of the round's Team Role) or 409 (the Grilling moved on): say so.
  const grilling = await api<GrillingView>(`/grillings/${id}`).catch(() => null);
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Grilling</h1>
      <div className="mt-4">
        <Notice tone="error">{problem ?? 'This Grilling Conversation could not be opened.'}</Notice>
      </div>
      {grilling && (
        <p className="mt-4">
          <a
            className="underline underline-offset-2"
            href={`/projects/${grilling.projectId}?tab=grilling`}
          >
            Open the Project’s Grilling
          </a>
        </p>
      )}
    </main>
  );
}
