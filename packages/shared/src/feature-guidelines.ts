import { z } from 'zod';
import { GuidelineCriterionKind } from './enums.ts';

const Id = z.uuid();

/** At most this many criteria in the Organization default, and overrides in one Project. */
export const MAX_GUIDELINE_CRITERIA = 50;

/** What a criterion says: checked one by one by the AI and the UI (REQUIREMENT §3.8). */
export const GuidelineCriterionText = z.object({
  title: z.string().trim().min(1, 'A criterion needs a title').max(200),
  description: z.string().trim().max(2000).default(''),
  kind: GuidelineCriterionKind,
  required: z.boolean(),
});
export type GuidelineCriterionText = z.infer<typeof GuidelineCriterionText>;

// ─── Organization default ─────────────────────────────────────────────────

/**
 * One criterion of the Organization default. Keep `id` to update an existing
 * criterion in place (the Projects' edits and hides of it stay attached); leave
 * it out to add one.
 */
export const OrgGuidelineCriterionInput = GuidelineCriterionText.extend({ id: Id.optional() });
export type OrgGuidelineCriterionInput = z.infer<typeof OrgGuidelineCriterionInput>;

/**
 * `PUT /settings/feature-guidelines`: the whole ordered default list. Criteria
 * left out are removed, with every Project's edits and hides of them.
 */
export const OrgFeatureGuidelinesInput = z.object({
  criteria: z.array(OrgGuidelineCriterionInput).max(MAX_GUIDELINE_CRITERIA),
});
export type OrgFeatureGuidelinesInput = z.infer<typeof OrgFeatureGuidelinesInput>;

export const GuidelineCriterionView = GuidelineCriterionText.extend({ id: Id });
export type GuidelineCriterionView = z.infer<typeof GuidelineCriterionView>;

/** `GET /settings/feature-guidelines`, in order. */
export const OrgFeatureGuidelinesView = z.object({
  organizationId: Id,
  criteria: z.array(GuidelineCriterionView),
});
export type OrgFeatureGuidelinesView = z.infer<typeof OrgFeatureGuidelinesView>;

// ─── Project overrides ────────────────────────────────────────────────────

/** A criterion only this Project has. */
export const AddGuidelineOverride = GuidelineCriterionText.extend({ action: z.literal('ADD') });
/** Replaces the text of a default criterion in this Project. */
export const EditGuidelineOverride = GuidelineCriterionText.extend({
  action: z.literal('EDIT'),
  overridesId: Id,
});
/** Hides a default criterion in this Project. */
export const DisableGuidelineOverride = z.object({
  action: z.literal('DISABLE'),
  overridesId: Id,
});

export const ProjectGuidelineOverrideInput = z.discriminatedUnion('action', [
  AddGuidelineOverride,
  EditGuidelineOverride,
  DisableGuidelineOverride,
]);
export type ProjectGuidelineOverrideInput = z.infer<typeof ProjectGuidelineOverrideInput>;

/**
 * `PUT /projects/:id/feature-guidelines`: all of the Project's overrides, replacing
 * the previous ones. Each default criterion is edited or disabled at most once and
 * must be in the Project's Organization default (422 otherwise).
 */
export const ProjectFeatureGuidelinesInput = z.object({
  overrides: z.array(ProjectGuidelineOverrideInput).max(MAX_GUIDELINE_CRITERIA),
});
export type ProjectFeatureGuidelinesInput = z.infer<typeof ProjectFeatureGuidelinesInput>;

export const ProjectGuidelineOverrideView = z.discriminatedUnion('action', [
  AddGuidelineOverride.extend({ id: Id }),
  EditGuidelineOverride.extend({ id: Id }),
  DisableGuidelineOverride.extend({ id: Id }),
]);
export type ProjectGuidelineOverrideView = z.infer<typeof ProjectGuidelineOverrideView>;

/** `GET /projects/:id/feature-guidelines`: the overrides in the order they were saved. */
export const ProjectFeatureGuidelinesView = z.object({
  projectId: Id,
  overrides: z.array(ProjectGuidelineOverrideView),
});
export type ProjectFeatureGuidelinesView = z.infer<typeof ProjectFeatureGuidelinesView>;

// ─── Effective ────────────────────────────────────────────────────────────

/**
 * Where an effective criterion comes from: the Organization default as is, a
 * Project addition, or a default criterion whose text the Project edited.
 */
export const GuidelineCriterionOrigin = z.enum(['ORGANIZATION', 'PROJECT', 'PROJECT_EDIT']);
export type GuidelineCriterionOrigin = z.infer<typeof GuidelineCriterionOrigin>;

export const EffectiveGuidelineCriterion = GuidelineCriterionText.extend({
  /** The row whose text applies: the default criterion, the addition or the edit. */
  id: Id,
  origin: GuidelineCriterionOrigin,
  /** For PROJECT_EDIT, the default criterion it replaces; null otherwise. */
  overridesId: Id.nullable(),
});
export type EffectiveGuidelineCriterion = z.infer<typeof EffectiveGuidelineCriterion>;

/**
 * `GET /projects/:id/feature-guidelines/effective`: the Organization default in
 * its order (disabled ones left out, edited ones replaced in place), then the
 * Project's additions in their order.
 */
export const EffectiveFeatureGuidelinesView = z.object({
  projectId: Id,
  criteria: z.array(EffectiveGuidelineCriterion),
});
export type EffectiveFeatureGuidelinesView = z.infer<typeof EffectiveFeatureGuidelinesView>;
