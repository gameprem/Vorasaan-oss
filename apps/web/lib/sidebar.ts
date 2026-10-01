import type {
  ConversationList,
  InboxItem,
  NotificationList,
  ProjectView,
  TeamView,
} from '@vorasaan/shared';
import { cache } from 'react';
import { api } from './api';

// What the Sidebar shows, loaded on the server by the root layout. Each part fails on its
// own: a Sidebar with no recent Conversations still lets you reach the Inbox.

export type SidebarFeature = {
  id: string;
  title: string;
  openBlockers: number;
  /** The latest Spec Version's number; 0 while it has no Spec. */
  specVersion: number;
};
export type SidebarProject = { id: string; name: string; features: SidebarFeature[] };
export type SidebarConversation = {
  id: string;
  title: string;
  /** The Feature's title, or the Project's name for a Project-wide Conversation. */
  scope: string;
  projectId: string;
  /** Null for a Project-wide Conversation. */
  featureId: string | null;
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
        .map((f) => ({
          id: f.id,
          title: f.title,
          openBlockers: f.openBlockers,
          specVersion: f.specVersion,
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
      return { id: p.id, name: p.name, features };
    }),
  );
}

/** Cached for one render: the layout and a page (the new Conversation's scope picker) share it. */
export const loadSidebar = cache(async (): Promise<SidebarData> => {
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
      projectId: c.scope.project.id,
      featureId: c.scope.kind === 'FEATURE' ? c.scope.feature.id : null,
    })),
  };
});
