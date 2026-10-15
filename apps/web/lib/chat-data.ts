import type {
  AiModelsView,
  ConversationScopeView,
  GrillingConversationRef,
  ProjectBriefView,
  SpecVersionView,
} from '@vorasaan/shared';
import type { ChatDoc } from '@/components/chat/doc-panel';
import { GRILLING_UI } from '@/components/chat/grilling-copy';
import { api } from './api';
import type { Lang } from './lang';

// What the chat view shows around a Conversation (ticket 0046), loaded on the server.

/** The latest Spec of a Feature, or the latest Brief of a Project; null when it can't be read. */
export async function loadDoc(scope: ConversationScopeView): Promise<ChatDoc | null> {
  try {
    if (scope.kind === 'FEATURE') {
      const versions = await api<SpecVersionView[]>(`/features/${scope.feature.id}/spec-versions`);
      const latest = versions.reduce<SpecVersionView | null>(
        (a, v) => (!a || v.version > a.version ? v : a),
        null,
      );
      return {
        kind: 'SPEC',
        title: scope.feature.title,
        version: latest?.version ?? 0,
        markdown: latest?.markdown ?? '',
        approvedBy: latest?.approvedBy.name ?? null,
        href: `/features/${scope.feature.id}`,
      };
    }
    const brief = await api<ProjectBriefView>(`/projects/${scope.project.id}/brief`);
    return {
      kind: 'BRIEF',
      title: scope.project.name,
      version: brief.version,
      markdown: brief.markdown,
      approvedBy: brief.current?.approvedBy.name ?? null,
      href: `/projects/${scope.project.id}`,
    };
  } catch {
    return null;
  }
}

/** The Approved Models for the composer's model menu (ticket 0054); none when they can't be read. */
export async function loadModels(): Promise<AiModelsView> {
  try {
    return await api<AiModelsView>('/ai/models');
  } catch {
    return {
      models: [],
      chatDefaultId: null,
      chatDefaultReasoning: { supported: false, reason: 'The models could not be loaded' },
    };
  }
}

/** The suggestions above the composer, inside a scope. */
export function chipsFor(
  scope: ConversationScopeView,
  grilling: GrillingConversationRef | null = null,
): string[] {
  // A Grilling Conversation's "Skip this question" chip is the chat's own (0047).
  if (grilling) return [];
  return scope.kind === 'FEATURE'
    ? ['Raise a Blocker', 'Draft the Spec from the Attachments', 'Summarize the open questions']
    : ['Suggest Features', 'Draft the Project Brief', 'What is this Project missing?'];
}

export function placeholderFor(
  scope: ConversationScopeView | null,
  grilling: GrillingConversationRef | null = null,
  lang: Lang = 'en',
): string {
  if (grilling) return GRILLING_UI[lang].placeholder;
  if (!scope) return 'Tell Vorasaan what you need…';
  return scope.kind === 'FEATURE'
    ? 'Ask about this Feature, or tell the AI what to draft…'
    : 'Ask about this Project, or tell the AI what to draft…';
}

/** "Context: Async checkout · Spec v1": what the AI reads on each turn. */
export function contextLabel(
  scope: ConversationScopeView,
  doc: ChatDoc | null,
  grilling: GrillingConversationRef | null = null,
  lang: Lang = 'en',
): string {
  if (grilling) return GRILLING_UI[lang].context;
  const name = scope.kind === 'FEATURE' ? scope.feature.title : scope.project.name;
  if (!doc) return `Context: ${name}`;
  const what = doc.kind === 'SPEC' ? 'Spec' : 'Brief';
  return `Context: ${name} · ${doc.version > 0 ? `${what} v${doc.version}` : `no ${what} yet`}`;
}

/**
 * Where an "Answer Grilling" Inbox Item or starter goes (ticket 0047): the person's
 * Grilling Conversation, or the page that opens it when they have none yet.
 */
export function grillingConversationHref(grilling: {
  id: string;
  conversationId: string | null;
}): string {
  return grilling.conversationId
    ? `/conversations/${grilling.conversationId}`
    : `/grillings/${grilling.id}/conversation`;
}
