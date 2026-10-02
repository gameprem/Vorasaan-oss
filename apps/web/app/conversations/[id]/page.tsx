import type { ConversationView } from '@vorasaan/shared';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Chat } from '@/components/chat/chat';
import { ApiError, api, currentUser } from '@/lib/api';
import { chipsFor, contextLabel, loadDoc, loadModels, placeholderFor } from '@/lib/chat-data';
import { isId } from '@/lib/ids';
import { requestLanguage } from '@/lib/lang';

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

// A Conversation (ADR 0008): the chat, its Action Cards, and its Spec or Project Brief.
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [conversation, me] = await Promise.all([load(id), currentUser()]);
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
    />
  );
}
