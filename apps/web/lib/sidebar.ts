import type {
  ConversationList,
  InboxItem,
  NotificationList,
  ProjectView,
  TeamView,
} from '@vorasaan/shared';
import { api } from './api';

// What the Sidebar shows, loaded on the server by the root layout. Each part fails on its
// own: a Sidebar with no recent Conversations still lets you reach the Inbox.

export type SidebarFeature = { id: string; title: string; openBlockers: number };
export type SidebarProject = { id: string; name: string; features: SidebarFeature[] };
export type SidebarConversation = {
  id: string;
  title: string;
  /** The Feature's title, or the Project's name for a Project-wide Conversation. */
  scope: string;
};
export type SidebarData = {
  /** Inbox Items waiting for the viewer. */
  inboxItems: number;
  unreadNotifications: number;
  projects: SidebarProject[];
  recent: SidebarConversation[];
};

const quiet = { redirectOnUnauthorized: false } as const;

async function loadProjects(): Promise<SidebarProject[]> {
  const projects = await api<ProjectView[]>('/projects', quiet);
  return Promise.all(
    projects.map(async (p) => {
      const teams = await Promise.all(
        p.teams
          .filter((t) => t.featureCount > 0)
          .map((t) => api<TeamView>(`/teams/${t.id}`, quiet).catch(() => null)),
      );
      const features = teams
        .flatMap((t) => t?.features ?? [])
        .map((f) => ({ id: f.id, title: f.title, openBlockers: f.openBlockers }))
        .sort((a, b) => a.title.localeCompare(b.title));
      return { id: p.id, name: p.name, features };
    }),
  );
}

export async function loadSidebar(): Promise<SidebarData> {
  const [inbox, notifications, projects, conversations] = await Promise.all([
    api<InboxItem[]>('/inbox', quiet).catch(() => []),
    api<NotificationList>('/notifications?unread=true&limit=1', quiet).catch(() => null),
    loadProjects().catch(() => []),
    api<ConversationList>('/conversations?recent', quiet).catch(() => null),
  ]);
  return {
    inboxItems: inbox.length,
    unreadNotifications: notifications?.unreadCount ?? 0,
    projects,
    recent: (conversations?.conversations ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      scope: c.scope.kind === 'FEATURE' ? c.scope.feature.title : c.scope.project.name,
    })),
  };
}
