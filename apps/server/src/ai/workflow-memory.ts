import { clipForAi } from '../attachments/attachment-context.ts';
import { fence } from './prompts.ts';

/**
 * What a multi-round Mastra workflow (e.g. Grilling, ticket 0032) keeps in its
 * state between rounds (ADR 0007): a short summary per earlier round, never the
 * whole transcript. The LLM is stateless, so each resumed step sends these
 * summaries plus freshly retrieved context (ContextRetriever), not the history.
 *
 * No workflow uses it yet; it is here so the first one starts with the rule.
 */
export type RoundSummary = { round: number; summary: string };

export type WorkflowMemory = { rounds: RoundSummary[] };

export const WORKFLOW_MEMORY_LIMITS = {
  /** Only the most recent rounds are kept; older ones are dropped. */
  maxRounds: 8,
  /** Each round's summary is cut to this many characters. */
  maxSummaryChars: 1_200,
} as const;

export function emptyMemory(): WorkflowMemory {
  return { rounds: [] };
}

/** A new memory with this round's summary added, shortened and within the round limit. */
export function rememberRound(
  memory: WorkflowMemory,
  summary: string,
  limits: { maxRounds: number; maxSummaryChars: number } = WORKFLOW_MEMORY_LIMITS,
): WorkflowMemory {
  const round = (memory.rounds.at(-1)?.round ?? 0) + 1;
  const entry = { round, summary: clipForAi(summary.trim(), limits.maxSummaryChars) };
  return { rounds: [...memory.rounds, entry].slice(-Math.max(1, limits.maxRounds)) };
}

/** The summaries as prompt text, oldest first. They are AI output: fence them like context. */
export function renderMemory(memory: WorkflowMemory): string {
  if (memory.rounds.length === 0) return '(No earlier rounds.)';
  return memory.rounds.map((r) => `Round ${r.round}: ${fence(r.summary)}`).join('\n');
}
