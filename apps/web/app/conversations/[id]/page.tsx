import type { ConversationView } from '@vorasaan/shared';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Chat } from '@/components/chat/chat';
import { ApiError, api, currentUser } from '@/lib/api';
import { chipsFor, contextLabel, loadDoc, loadModels, placeholderFor } from '@/lib/chat-data';
import { isId } from '@/lib/ids';
import { requestLanguage } from '@/lib/lang';

/** The Conversation with its latest messages, or those around `message` (a deep link, 0066). */
async function load(id: string, message?: string | null) {
  if (!isId(id)) notFound();
  try {
    const around = message ? `?around=${message}` : '';
    return await api<ConversationView>(`/conversations/${id}${around}`);
  } catch (error) {
    // A link to a message that isn't there (any more) opens the Conversation as usual.
    if (message && error instanceof ApiError && error.status === 404) return load(id);
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

// A Conversation (ADR 0008): the chat, its Action Cards, and its Spec or Project Brief.
// `?message=<id>` opens it at that message (ticket 0066).
export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string | string[] }>;
}) {
  const { id } = await params;
  const { message } = await searchParams;
  const focus = typeof message === 'string' && isId(message) ? message : null;
  const [conversation, me] = await Promise.all([load(id, focus), currentUser()]);
  if (!me) redirect('/login');
  const { scope, grilling } = conversation;
  const [doc, models, lang] = await Promise.all([loadDoc(scope), loadModels(), requestLanguage()]);

  return (
    <Chat
      // Another Conversation is another chat: nothing of this one's state carries over.
      key={conversation.id}
      me={{ id: me.id, name: me.name }}
      initial={conversation}
      scope={scope}
      doc={doc}
      chips={chipsFor(scope, grilling)}
      placeholder={placeholderFor(scope, grilling, lang)}
      context={contextLabel(scope, doc, grilling, lang)}
      // A Grilling Conversation's questions come from the server: no model to pick.
      models={grilling ? null : models}
      lang={lang}
      focusMessageId={focus}
    />
  );
}
