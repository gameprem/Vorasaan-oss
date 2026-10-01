import type { ConversationScopeView, FeatureSummaryView, InboxItem } from '@vorasaan/shared';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  type Lang,
  NewConversation,
  type ScopeOption,
  type Starter,
} from '@/components/chat/new-conversation';
import { ROUND_LABEL } from '@/components/ui';
import { api, currentUser } from '@/lib/api';
import { chipsFor } from '@/lib/chat-data';
import { isId } from '@/lib/ids';
import { scopeKey } from '@/lib/scope-key';
import { loadSidebar, type SidebarProject } from '@/lib/sidebar';

export const metadata = { title: 'New conversation' };

const MAX_STARTERS = 4;

/**
 * The visitor's language, from the browser's Accept-Language: Thai when Thai comes before
 * English, English otherwise. Nothing stores a language preference yet.
 */
function preferredLanguage(header: string | null): Lang {
  const tags = (header ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().toLowerCase().split(';');
      const q = Number(
        params
          .find((p) => p.trim().startsWith('q='))
          ?.trim()
          .slice(2) ?? 1,
      );
      return { tag, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((t) => t.tag && t.q > 0)
    .sort((a, b) => b.q - a.q);
  const first = tags.find((t) => t.tag.startsWith('th') || t.tag.startsWith('en'));
  return first?.tag.startsWith('th') ? 'th' : 'en';
}

const STARTER_COPY = {
  en: {
    decide: (title: string) => `Help me decide “${title}”`,
    answer: (who: string, title: string) => `Answer ${who}’s question on “${title}”`,
    specProposal: (feature: string) => `Walk me through the Spec Proposal for ${feature}`,
    briefProposal: (project: string) => `Walk me through the Brief Proposal for ${project}`,
    grilling: (round: string, left: number) =>
      `Answer the ${round} round of Grilling (${left} question${left === 1 ? '' : 's'} left)`,
    noSpec: (feature: string) => `Draft the Spec of ${feature} from its Attachments`,
    suggest: (project: string) => `Suggest Features for ${project}`,
    inbox: 'In your Inbox',
    theDecider: 'the Decider',
  },
  th: {
    decide: (title: string) => `ช่วยตัดสินใจเรื่อง “${title}”`,
    answer: (who: string, title: string) => `ตอบคำถามของ ${who} เรื่อง “${title}”`,
    specProposal: (feature: string) => `สรุป Spec Proposal ของ ${feature} ให้หน่อย`,
    briefProposal: (project: string) => `สรุป Brief Proposal ของ ${project} ให้หน่อย`,
    grilling: (round: string, left: number) => `ตอบคำถาม Grilling รอบ ${round} ที่เหลือ ${left} ข้อ`,
    noSpec: (feature: string) => `ร่าง Spec ของ ${feature} จาก Attachments ที่แนบไว้`,
    suggest: (project: string) => `แนะนำ Feature สำหรับ ${project}`,
    inbox: 'ใน Inbox',
    theDecider: 'ผู้ตัดสินใจ',
  },
} as const;

function featureScope(
  projects: SidebarProject[],
  featureId: string,
  title: string,
): ConversationScopeView | undefined {
  const project = projects.find((p) => p.features.some((f) => f.id === featureId));
  return project
    ? {
        kind: 'FEATURE',
        project: { id: project.id, name: project.name },
        feature: { id: featureId, title },
      }
    : undefined;
}

/** Starter cards from the visitor's real pending work, the most pressing first. */
function startersFrom(
  lang: Lang,
  inbox: InboxItem[],
  myFeatures: FeatureSummaryView[],
  projects: SidebarProject[],
): Starter[] {
  const t = STARTER_COPY[lang];
  const starters: Starter[] = [];
  for (const item of inbox) {
    switch (item.kind) {
      case 'DECIDE':
      case 'CLAIM':
        starters.push({
          text: t.decide(item.decisionRequest.title),
          sub: item.feature.title,
          tag: t.inbox,
          scope: featureScope(projects, item.feature.id, item.feature.title),
        });
        break;
      case 'ANSWER':
        starters.push({
          text: t.answer(
            item.decisionRequest.decider?.name ?? t.theDecider,
            item.decisionRequest.title,
          ),
          sub: item.feature.title,
          tag: t.inbox,
          scope: featureScope(projects, item.feature.id, item.feature.title),
        });
        break;
      case 'APPROVE_PROPOSAL':
        starters.push({
          text: t.specProposal(item.feature.title),
          sub: item.feature.title,
          tag: t.inbox,
          scope: featureScope(projects, item.feature.id, item.feature.title),
        });
        break;
      case 'APPROVE_BRIEF_PROPOSAL':
        starters.push({
          text: t.briefProposal(item.project.name),
          sub: item.project.name,
          tag: t.inbox,
          scope: { kind: 'PROJECT', project: item.project },
        });
        break;
      case 'ANSWER_GRILLING':
        starters.push({
          text: t.grilling(ROUND_LABEL[item.grilling.round], item.grilling.unanswered),
          sub: item.project.name,
          tag: 'Grilling',
          href: item.grilling.conversationId
            ? `/conversations/${item.grilling.conversationId}`
            : `/projects/${item.project.id}?tab=grilling`,
        });
        break;
    }
  }
  // Pressing work first, but leave room for a Feature without a Spec.
  const picked = starters.slice(0, MAX_STARTERS - 1);
  const specless = myFeatures.filter((f) =>
    projects.some((p) => p.features.some((s) => s.id === f.id && s.specVersion === 0)),
  );
  for (const f of specless.slice(0, MAX_STARTERS - picked.length)) {
    picked.push({
      text: t.noSpec(f.title),
      sub: f.title,
      scope: featureScope(projects, f.id, f.title),
    });
  }
  for (const p of projects) {
    if (picked.length >= MAX_STARTERS) break;
    picked.push({
      text: t.suggest(p.name),
      sub: p.name,
      scope: { kind: 'PROJECT', project: { id: p.id, name: p.name } },
    });
  }
  return picked;
}

function scopeOptions(projects: SidebarProject[]): ScopeOption[] {
  return projects.flatMap((p) => {
    const project = { id: p.id, name: p.name };
    return [
      {
        value: `p:${p.id}`,
        label: `${p.name} (the whole Project)`,
        group: p.name,
        scope: { kind: 'PROJECT', project } as const,
      },
      ...p.features.map((f) => ({
        value: `f:${f.id}`,
        label: f.title,
        group: p.name,
        scope: { kind: 'FEATURE', project, feature: { id: f.id, title: f.title } } as const,
      })),
    ];
  });
}

// A new Conversation (ADR 0008). `?feature=` or `?project=` starts it in that scope (the
// Sidebar opens one there when it has none yet).
export default async function NewConversationPage({
  searchParams,
}: {
  searchParams: Promise<{ feature?: string | string[]; project?: string | string[] }>;
}) {
  const me = await currentUser();
  if (!me) redirect('/login');
  const { feature, project } = await searchParams;
  const lang = preferredLanguage((await headers()).get('accept-language'));
  const [sidebar, inbox, myFeatures] = await Promise.all([
    loadSidebar(),
    api<InboxItem[]>('/inbox').catch(() => []),
    api<FeatureSummaryView[]>('/features').catch(() => []),
  ]);
  const options = scopeOptions(sidebar.projects);
  const wanted = isId(feature) ? `f:${feature}` : isId(project) ? `p:${project}` : null;
  const initialScope = options.find((o) => o.value === wanted)?.scope ?? null;
  const chips = Object.fromEntries(options.map((o) => [scopeKey(o.scope), chipsFor(o.scope)]));

  return (
    <NewConversation
      // A new scope from the Sidebar starts afresh.
      key={wanted ?? 'none'}
      me={{ id: me.id, name: me.name }}
      lang={lang}
      options={options}
      initialScope={initialScope}
      starters={startersFrom(lang, inbox, myFeatures, sidebar.projects)}
      chipsFor={chips}
    />
  );
}
