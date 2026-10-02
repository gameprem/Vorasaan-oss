import type { ConversationList } from '@vorasaan/shared';
import { notFound, redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { isId } from '@/lib/ids';

// A Project or Feature picked in the Sidebar: its latest Conversation, or a new one there.
// A Project's own Conversations are the Project-wide ones that aren't Grilling.
export default async function OpenConversation({
  searchParams,
}: {
  searchParams: Promise<{ feature?: string | string[]; project?: string | string[] }>;
}) {
  const { feature, project } = await searchParams;
  if (isId(feature)) {
    const { conversations } = await api<ConversationList>(
      `/conversations?featureId=${feature}&limit=1`,
    );
    const latest = conversations[0];
    redirect(latest ? `/conversations/${latest.id}` : `/conversations/new?feature=${feature}`);
  }
  if (isId(project)) {
    const { conversations } = await api<ConversationList>(
      `/conversations?projectId=${project}&limit=100`,
    );
    const latest = conversations.find((c) => c.scope.kind === 'PROJECT' && !c.grilling);
    redirect(latest ? `/conversations/${latest.id}` : `/conversations/new?project=${project}`);
  }
  notFound();
}
