import { Injectable } from '@nestjs/common';

/**
 * Something a person may get as a card in their chat apps (ticket 0058), collected in an
 * Outbox inside the change's transaction and handed on only after it commits. Which
 * card it becomes, and whether it goes now, later or not at all, is up to the chat apps
 * (their Chat Accounts, preferences and Quiet Hours).
 */
export type ChatCardSignal =
  /** A Decision Request sent to them (or back to its Decider with the Raiser's answer). */
  | { kind: 'DECISION_REQUEST'; requestId: string; to: string[] }
  /** The Decider's question, to the Raiser. */
  | { kind: 'NEEDS_INFO'; requestId: string; to: string[] }
  /** A Spec Proposal to approve: a link only. */
  | { kind: 'SPEC_PROPOSAL'; specProposalId: string; requestId: string; to: string[] }
  /** An escalation step (1 reminder, 2 Delegate added, 3 overdue) to whoever it targets. */
  | { kind: 'ESCALATION'; requestId: string; step: number; to: string[] };

export type ChatCardListener = (signals: readonly ChatCardSignal[]) => void;

/**
 * Hands committed ChatCardSignals to the chat apps. It lives with the Inbox so Decision
 * Requests and escalation can raise them without depending on the chat apps, which
 * themselves depend on Decision Requests (a button press decides through them).
 */
@Injectable()
export class ChatCardSignals {
  private listener: ChatCardListener | undefined;

  listen(listener: ChatCardListener): void {
    this.listener = listener;
  }

  /** Never throws and never waits: sending a card must not hold up or fail the change. */
  dispatch(signals: readonly ChatCardSignal[]): void {
    if (!signals.length || !this.listener) return;
    try {
      this.listener(signals);
    } catch {
      // The listener queues its own work and logs its own failures.
    }
  }
}
