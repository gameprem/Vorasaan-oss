import type { PrismaClient } from '@vorasaan/db';
import { ProposalKind, ReceiptOutcomeKind } from '@vorasaan/shared';
import { z } from 'zod';
import type { PatternForAi } from '../ai/ai.port.ts';

// The patterns an analysis found in a prompt's feedback (ticket 0072), as stored on the
// PromptAnalysis: each with the outcomes it cites, by id. People's words (a decline reason,
// Request changes feedback) are never copied: they are read from the outcomes, so they go
// when retention deletes those (ADR 0015: private by default).

/** A pattern needs at least this many cases: a one-off remark is not one. */
export const MIN_PATTERN_CASES = 2;

/** How many of a pattern's cases' words the proposal is shown as examples. */
const EXAMPLES = 3;

export const StoredPatternCase = z.object({
  outcomeId: z.string(),
  receiptId: z.string(),
  kind: ReceiptOutcomeKind,
  proposalKind: ProposalKind,
  proposalId: z.string(),
  redraft: z.int().min(1),
  /** Never stored: filled in from the outcome while it is kept (`withCaseTexts`). */
  text: z.string().nullable().optional(),
  at: z.string(),
});
export type StoredPatternCase = z.infer<typeof StoredPatternCase>;

export const StoredPattern = z.object({
  title: z.string(),
  description: z.string(),
  count: z.int().min(1),
  cases: z.array(StoredPatternCase),
});
export type StoredPattern = z.infer<typeof StoredPattern>;

/** The stored patterns of an analysis; none while it runs, or when they don't parse. */
export function storedPatterns(value: unknown): StoredPattern[] {
  const parsed = z.array(StoredPattern).safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** Patterns as the proposal and its Redrafts are given them: counts and a few examples. */
export function patternsForAi(patterns: StoredPattern[]): PatternForAi[] {
  return patterns.map((p) => ({
    title: p.title,
    description: p.description,
    count: p.count,
    examples: p.cases
      .map((c) => c.text?.trim() ?? '')
      .filter(Boolean)
      .slice(0, EXAMPLES),
  }));
}

/** The patterns as stored: without people's words. */
export function forStorage(patterns: StoredPattern[]): StoredPattern[] {
  return patterns.map((p) => ({
    ...p,
    cases: p.cases.map(({ text: _, ...c }) => c),
  }));
}

/** The patterns with each case's words read from its outcome; null once retention deleted it. */
export async function withCaseTexts(
  db: Pick<PrismaClient, 'receiptOutcome'>,
  patterns: StoredPattern[],
): Promise<StoredPattern[]> {
  const ids = [...new Set(patterns.flatMap((p) => p.cases.map((c) => c.outcomeId)))];
  if (!ids.length) return patterns;
  const rows = await db.receiptOutcome.findMany({
    where: { id: { in: ids } },
    select: { id: true, reason: true },
  });
  const texts = new Map(rows.map((r) => [r.id, r.reason]));
  return patterns.map((p) => ({
    ...p,
    cases: p.cases.map((c) => ({ ...c, text: texts.get(c.outcomeId) ?? null })),
  }));
}
