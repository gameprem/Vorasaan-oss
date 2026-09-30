import { Injectable } from '@nestjs/common';
import type { ServerEvent } from '@vorasaan/shared';

export type EventListener = (event: ServerEvent) => void;

/**
 * In-process pub/sub from services to the `GET /events` streams, keyed by User.
 * One server process serves one Organization, so one bus is enough; running several
 * processes would need a shared broker (e.g. Postgres LISTEN/NOTIFY) behind this API.
 */
@Injectable()
export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();

  /** Returns the function that removes the listener again. */
  subscribe(userId: string, listener: EventListener): () => void {
    const set = this.listeners.get(userId) ?? new Set<EventListener>();
    this.listeners.set(userId, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(userId) === set) this.listeners.delete(userId);
    };
  }

  emit(userId: string, event: ServerEvent) {
    for (const listener of this.listeners.get(userId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken stream must not stop the others; its own close handler cleans it up.
      }
    }
  }

  /** Open listeners across every User (for tests and diagnostics). */
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}
