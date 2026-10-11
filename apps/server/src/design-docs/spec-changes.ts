import { Global, Injectable, Logger, Module } from '@nestjs/common';

/** Told the Feature whose Spec, Spec Proposals or target Platforms just changed. */
export type SpecChangeListener = (featureId: string) => void;

/**
 * Where the services that change what a Design Doc is drafted from say so (ticket 0069),
 * after their change has committed: a new Spec Version (approved, written by hand or
 * reverted), a Spec Proposal declined, or the Feature's target Platforms changed. The Design
 * Docs listen, so neither side imports the other's module.
 */
@Injectable()
export class SpecChanges {
  private readonly logger = new Logger(SpecChanges.name);
  private readonly listeners = new Set<SpecChangeListener>();

  /** Returns the unsubscribe. */
  listen(listener: SpecChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(featureId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(featureId);
      } catch (error) {
        this.logger.warn(`A Spec change listener failed: ${(error as Error)?.message}`);
      }
    }
  }
}

@Global()
@Module({ providers: [SpecChanges], exports: [SpecChanges] })
export class SpecChangesModule {}
