import type { FeatureDeletedEvent, ProjectDeletedEvent } from '@vorasaan/shared';

// A Feature or a Project was deleted (ticket 0049). LiveUpdates hears it on the event stream
// and decides whether the page on screen showed it; pages whose path doesn't say so (a
// Decision Request, a Conversation) name what they show with <DeletionWatch>.

export type Deleted =
  | { kind: 'feature'; data: FeatureDeletedEvent }
  | { kind: 'project'; data: ProjectDeletedEvent };

/** What the page on screen shows, as <DeletionWatch> declared it. */
export type Shown = { featureId?: string; projectId?: string };

let shown: Shown = {};

export function setShown(next: Shown): () => void {
  shown = next;
  return () => {
    if (shown === next) shown = {};
  };
}

/** Deletes this browser made itself: their dialog already navigated and said so. */
const own = new Set<string>();

export function markOwnDelete(id: string) {
  own.add(id);
}

export function isOwnDelete(id: string) {
  return own.has(id);
}

/**
 * Where to go when `deleted` took the page at `path` with it, or null when the page didn't
 * show it.
 */
export function leaveTo(deleted: Deleted, path: string): string | null {
  const [, section, id] = path.split('/');
  if (deleted.kind === 'feature') {
    const { featureId, projectId } = deleted.data;
    if ((section === 'features' && id === featureId) || shown.featureId === featureId) {
      return `/projects/${projectId}`;
    }
    return null;
  }
  const { projectId, teamIds, featureIds } = deleted.data;
  const gone =
    (section === 'projects' && id === projectId) ||
    (section === 'teams' && teamIds.includes(id ?? '')) ||
    (section === 'features' && featureIds.includes(id ?? '')) ||
    shown.projectId === projectId ||
    (shown.featureId !== undefined && featureIds.includes(shown.featureId));
  return gone ? '/projects' : null;
}

export function deletedText(deleted: Deleted): string {
  return deleted.kind === 'feature'
    ? `The Feature “${deleted.data.title}” was deleted.`
    : `The Project “${deleted.data.name}” was deleted.`;
}

/** The window event that hands a status message to LiveUpdates' always-present live region. */
export const ANNOUNCE_EVENT = 'vorasaan:announce';

/**
 * Says `text` in the shell's polite live region, which outlives a navigation (a dialog's own
 * region goes with its page), and shows it as a toast.
 */
export function announce(text: string) {
  window.dispatchEvent(new CustomEvent<string>(ANNOUNCE_EVENT, { detail: text }));
}
