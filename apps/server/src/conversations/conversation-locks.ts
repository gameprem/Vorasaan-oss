import { ConflictException, Injectable, Module } from '@nestjs/common';

/**
 * One writer at a time per Conversation: a reply (0042), or the server adding
 * messages to a Grilling Conversation (0044). Held in the server process, like
 * the EventBus (one server process per Organization).
 */
@Injectable()
export class ConversationLocks {
  private readonly held = new Set<string>();

  /** Runs `work` while nobody else writes in this Conversation; 409 when someone does. */
  async exclusively<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (!this.tryAcquire(id)) {
      throw new ConflictException('A reply is still being written in this Conversation');
    }
    try {
      return await work();
    } finally {
      this.held.delete(id);
    }
  }

  /**
   * Runs `work` if nobody writes in this Conversation now, and returns whether it
   * ran. For updates the current writer will see anyway when it reads the state.
   */
  async ifFree(id: string, work: () => Promise<void>): Promise<boolean> {
    if (!this.tryAcquire(id)) return false;
    try {
      await work();
      return true;
    } finally {
      this.held.delete(id);
    }
  }

  private tryAcquire(id: string): boolean {
    if (this.held.has(id)) return false;
    this.held.add(id);
    return true;
  }
}

/** Shared by the Conversations and Grilling modules, so both use the same locks. */
@Module({ providers: [ConversationLocks], exports: [ConversationLocks] })
export class ConversationLocksModule {}
