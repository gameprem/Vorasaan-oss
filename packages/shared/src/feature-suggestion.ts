import { z } from 'zod';
import { PersonRef } from './decision-request.ts';
import {
  FeatureStatus,
  FeatureSuggestionStatus,
  GuidelineCriterionKind,
  SuggestionLevel,
} from './enums.ts';
import { SpecProposalView } from './spec.ts';

const Id = z.uuid();
const Timestamp = z.iso.datetime();

/** How many Feature Suggestions one generation asks for, by default and at most. */
export const DEFAULT_FEATURE_SUGGESTIONS = 5;
export const MAX_FEATURE_SUGGESTIONS = 10;

/** A Feature the AI proposes for the Project (REQUIREMENT §3.8, ticket 0034). */
export const FeatureSuggestionView = z.object({
  id: Id,
  projectId: Id,
  /** Suggestions generated together share it. */
  batchId: Id,
  title: z.string(),
  rationale: z.string(),
  businessValue: z.string(),
  effort: SuggestionLevel,
  risk: SuggestionLevel,
  /** The effective Feature Guidelines criteria it serves, as when it was generated. */
  servesGuidelineIds: z.array(Id),
  status: FeatureSuggestionStatus,
  dismissReason: z.string().nullable(),
  decidedBy: PersonRef.nullable(),
  decidedAt: Timestamp.nullable(),
  /** The Feature created when it was accepted. */
  featureId: Id.nullable(),
  generatedBy: PersonRef,
  createdAt: Timestamp,
});
export type FeatureSuggestionView = z.infer<typeof FeatureSuggestionView>;

/** `POST /projects/:id/feature-suggestions/generate`. The body is optional. */
export const GenerateFeatureSuggestionsInput = z
  .object({
    count: z.int().min(1).max(MAX_FEATURE_SUGGESTIONS).optional(),
  })
  .optional();
export type GenerateFeatureSuggestionsInput = z.infer<typeof GenerateFeatureSuggestionsInput>;

/** `GET /projects/:id/feature-suggestions?status=`. */
export const ListFeatureSuggestionsQuery = z.object({
  status: FeatureSuggestionStatus.optional(),
});
export type ListFeatureSuggestionsQuery = z.infer<typeof ListFeatureSuggestionsQuery>;

/** `POST /feature-suggestions/:id/accept`: the Team (of the same Project) the Feature goes to. */
export const AcceptFeatureSuggestionInput = z.object({ teamId: Id });
export type AcceptFeatureSuggestionInput = z.infer<typeof AcceptFeatureSuggestionInput>;

export const AcceptFeatureSuggestionResult = z.object({
  suggestion: FeatureSuggestionView,
  feature: z.object({ id: Id, teamId: Id, title: z.string(), status: FeatureStatus }),
  /** The AI-drafted first Spec, for the accepting PO to approve. */
  proposal: SpecProposalView,
});
export type AcceptFeatureSuggestionResult = z.infer<typeof AcceptFeatureSuggestionResult>;

/** `POST /feature-suggestions/:id/dismiss`: the reason is sent to the AI next time. */
export const DismissFeatureSuggestionInput = z.object({
  reason: z.string().trim().min(1, 'Say why it is dismissed').max(1000),
});
export type DismissFeatureSuggestionInput = z.infer<typeof DismissFeatureSuggestionInput>;

// ─── Fit check ────────────────────────────────────────────────────────────────

export const GuidelineFitVerdict = z.enum(['MET', 'UNCLEAR', 'NOT_MET']);
export type GuidelineFitVerdict = z.infer<typeof GuidelineFitVerdict>;

/** `POST /projects/:id/feature-fit`: a Feature someone is about to create by hand. */
export const FeatureFitInput = z.object({
  title: z.string().trim().min(1, 'Give the Feature a title').max(200),
  description: z.string().trim().max(10_000).default(''),
});
export type FeatureFitInput = z.input<typeof FeatureFitInput>;

export const GuidelineFitView = z.object({
  guidelineId: Id,
  title: z.string(),
  kind: GuidelineCriterionKind,
  required: z.boolean(),
  verdict: GuidelineFitVerdict,
  /** One line. */
  reason: z.string(),
});
export type GuidelineFitView = z.infer<typeof GuidelineFitView>;

/** One entry per effective Guideline, in their order, plus questions about the UNCLEAR ones. */
export const FeatureFitView = z.object({
  projectId: Id,
  results: z.array(GuidelineFitView),
  questions: z.array(z.object({ guidelineId: Id, question: z.string() })),
});
export type FeatureFitView = z.infer<typeof FeatureFitView>;
