import { z } from 'zod';
import { RecordedModel } from './ai-settings.ts';
import { headingKey, specHeadings } from './coverage.ts';
import { PersonRef } from './decision-request.ts';
import { MAX_DESIGN_TEMPLATE_CHARS } from './design-doc-values.ts';
import {
  DecisionRequestStatus,
  DesignDocProposalReason,
  DesignDocProposalStatus,
  DesignDocVersionSource,
  DesignTemplateKind,
  TeamRole,
} from './enums.ts';
import { PlatformRef } from './platform.ts';

// Design Docs (ADR 0014, ticket 0069): for each target Platform of a Feature, and for QA, the
// human-approved description of how it will build what the approved Spec says. The AI drafts
// one from the Spec once the Platform's Coverage is complete; a Tech Lead or a Role Owner of
// the Platform's Team Roles approves it. It follows a Spec Version and goes stale when a new
// one changes what it covers; it never changes the Spec.

const Id = z.uuid();
const Timestamp = z.iso.datetime();

// ─── Templates ──────────────────────────────────────────────────────────────

const OPEN_QUESTIONS = `## Open questions

- What the Spec and the Decisions leave undecided for this design. Each one is raised as a Decision Request.
`;

const FRONT_END_SECTIONS = `## Screens and states

For each screen: what it shows, and its loading, empty, error and success states.

## API calls

Each call the screens make, when, and what they do with the answer and with each error.

## Validation

Each input, its rules and the message shown when it fails.
`;

/**
 * The built-in templates (ADR 0014). Each `##` section is a part of the design the AI fills
 * from the approved Spec and the Decisions; what they leave open goes under Open questions.
 * A Project can replace any of them (`DesignTemplate`).
 */
export const BUILT_IN_DESIGN_TEMPLATES: Record<DesignTemplateKind, string> = {
  BACK_END: `## API contract

Each endpoint: method and path, request, response, status codes, and who may call it.

## Data model

Tables or documents, their fields and types, keys, indexes and constraints.

## Sequences

The main flows step by step, between the client, this service and other systems.

## Error cases

What can fail, how each failure is reported, and what is retried.

${OPEN_QUESTIONS}`,
  FRONT_END: `${FRONT_END_SECTIONS}
${OPEN_QUESTIONS}`,
  MOBILE: `${FRONT_END_SECTIONS}
## Offline

What works without a connection, what is cached or queued, and how it syncs back.

## Push notifications

Each push: when it is sent, its text, and what opening it does.

${OPEN_QUESTIONS}`,
  QA: `## Test plan

What is tested on each target Platform, how (manual, automated, end to end), and with which data.

## Test cases

Each test case traced to one acceptance criterion of the Spec: \`- [ ] TC-1 (AC: <the criterion>): steps → expected result\`.

${OPEN_QUESTIONS}`,
};

/** The Team Roles who approve a Design Doc: Tech Leads, and the Platform's (QA's for QA). */
export function designDocRoles(platformRoles: readonly TeamRole[] | null): TeamRole[] {
  return [...new Set<TeamRole>(['TECH_LEAD', ...(platformRoles ?? ['QA'])])];
}

/** `PUT /projects/:id/design-templates/:kind`: the Project's own template of that kind. */
export const SetDesignTemplateInput = z.object({
  markdown: z
    .string()
    .trim()
    .min(1, 'A template needs at least one section')
    .max(MAX_DESIGN_TEMPLATE_CHARS),
});
export type SetDesignTemplateInput = z.infer<typeof SetDesignTemplateInput>;

export const DesignTemplateView = z.object({
  kind: DesignTemplateKind,
  markdown: z.string(),
  /** True while the Project uses the built-in template of this kind. */
  builtIn: z.boolean(),
});
export type DesignTemplateView = z.infer<typeof DesignTemplateView>;

/** `GET /projects/:id/design-templates`: every kind, in order. */
export const DesignTemplatesView = z.object({
  projectId: Id,
  /** Admins and the POs of the Project's Teams, as for its Platforms. */
  canEdit: z.boolean(),
  templates: z.array(DesignTemplateView),
});
export type DesignTemplatesView = z.infer<typeof DesignTemplatesView>;

// ─── What a Design Doc covers ───────────────────────────────────────────────

/**
 * The part of a Spec a Design Doc covers: for a Platform, the whole Spec without the `##`
 * sections of the Feature's other target Platforms (its own section and every general one,
 * such as the user flow and the acceptance criteria); for QA (`platform` null), the whole
 * Spec. Compared line by line with trailing spaces and blank runs folded, so reflowing
 * whitespace changes nothing.
 */
export function designDocScope(
  specMarkdown: string,
  platform: string | null,
  targets: readonly string[],
): string {
  const { lines, headings } = specHeadings(specMarkdown);
  const own = platform === null ? null : headingKey(platform);
  const others = new Set(targets.map(headingKey).filter((k) => k !== own));
  const drop = new Set<number>();
  if (platform !== null) {
    for (const h of headings) {
      if (h.level === 2 && others.has(headingKey(h.text))) {
        for (let i = h.line; i < h.end; i++) drop.add(i);
      }
    }
  }
  return lines
    .filter((_, i) => !drop.has(i))
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

/** Whether a new Spec changes what a Design Doc covers, so the Design Doc goes stale. */
export function designDocAffected(
  before: string,
  after: string,
  platform: string | null,
  targets: readonly string[],
): boolean {
  return designDocScope(before, platform, targets) !== designDocScope(after, platform, targets);
}

// ─── Views ──────────────────────────────────────────────────────────────────

/** A Design Doc's key in paths: its Platform's id, or `qa` for the QA Design Doc. */
export const DesignDocKey = z.union([Id, z.literal('qa')]);
export type DesignDocKey = z.infer<typeof DesignDocKey>;

/**
 * Where a Design Doc stands:
 * - WAITING: it can't be drafted yet (`waiting` says why);
 * - READY: it can be drafted and nothing is drafted yet (a failed draft, or a change the AI
 *   wasn't told about): whoever approves it can ask for the draft;
 * - DRAFTING: the AI is writing a draft;
 * - PROPOSED: its first draft waits for approval;
 * - APPROVED: it has an approved version that follows what the latest Spec says;
 * - STALE: the latest Spec changed what its approved version covers; the AI proposes an update.
 */
export const DesignDocState = z.enum([
  'WAITING',
  'READY',
  'DRAFTING',
  'PROPOSED',
  'APPROVED',
  'STALE',
]);
export type DesignDocState = z.infer<typeof DesignDocState>;

/** Why a Design Doc can't be drafted yet. */
export const DesignDocWait = z.discriminatedUnion('kind', [
  /** The Feature has no Spec Version yet. */
  z.object({ kind: z.literal('NO_SPEC') }),
  /** A Spec Proposal awaits approval: the AI designs only from a settled Spec. */
  z.object({ kind: z.literal('SPEC_PROPOSAL_PENDING'), proposalId: Id }),
  /** The Platform's Coverage is missing (the reasons are on the Coverage chips). */
  z.object({ kind: z.literal('COVERAGE_MISSING') }),
  /** QA: these target Platforms aren't covered yet (QA designs once every one is). */
  z.object({ kind: z.literal('PLATFORMS_NOT_COVERED'), platforms: z.array(PlatformRef) }),
  /** QA: the Feature targets no Platform. */
  z.object({ kind: z.literal('NO_TARGETS') }),
]);
export type DesignDocWait = z.infer<typeof DesignDocWait>;

/** Why a Design Doc can't be drafted, in words (the API's 422, the web's list). */
export function designDocWaitText(name: string, wait: DesignDocWait): string {
  switch (wait.kind) {
    case 'NO_SPEC':
      return `The Feature has no approved Spec yet, so the ${name} Design Doc can't be drafted`;
    case 'SPEC_PROPOSAL_PENDING':
      return `A Spec Proposal awaits approval: the ${name} Design Doc is drafted once the Spec is settled`;
    case 'COVERAGE_MISSING':
      return `${name} isn't covered yet (see its Coverage), so its Design Doc can't be drafted`;
    case 'PLATFORMS_NOT_COVERED':
      return `The QA Design Doc is drafted once every target Platform is covered; not yet: ${wait.platforms.map((p) => p.name).join(', ')}`;
    case 'NO_TARGETS':
      return 'The Feature targets no Platform yet, so there is nothing for QA to plan';
  }
}

/** A question the AI found while drafting, raised as a Decision Request on the Feature. */
export const DesignDocQuestion = z.object({
  id: Id,
  title: z.string(),
  status: DecisionRequestStatus,
  raiser: PersonRef,
});
export type DesignDocQuestion = z.infer<typeof DesignDocQuestion>;

/** One Design Doc of a Feature, as its list shows it. */
export const DesignDocSummary = z.object({
  key: DesignDocKey,
  /** Null for the QA Design Doc. */
  platform: PlatformRef.nullable(),
  /** "Back-End", or "QA". */
  name: z.string(),
  template: DesignTemplateKind,
  state: DesignDocState,
  waiting: z.array(DesignDocWait),
  /** The approved version in use, and the Spec Version it follows. */
  current: z
    .object({
      version: z.int().positive(),
      specVersion: z.int().positive(),
      approvedBy: PersonRef,
      createdAt: Timestamp,
    })
    .nullable(),
  /** The proposal waiting for approval (a first draft or an update), if any. */
  proposal: z
    .object({
      id: Id,
      reason: DesignDocProposalReason,
      specVersion: z.int().positive(),
      createdAt: Timestamp,
    })
    .nullable(),
  /** Why the last draft failed, until the next one starts. */
  draftError: z.string().nullable(),
  /** Whether the viewer approves it: a Tech Lead or a Role Owner of its Team Roles. */
  canApprove: z.boolean(),
  /** The Team Roles who approve it. */
  approverRoles: z.array(TeamRole),
  /** Questions its drafts raised, oldest first. */
  questions: z.array(DesignDocQuestion),
});
export type DesignDocSummary = z.infer<typeof DesignDocSummary>;

/** `GET /features/:id/design-docs`: one per target Platform in the Project's order, then QA. */
export const FeatureDesignDocsView = z.object({
  featureId: Id,
  /** The latest Spec Version; null before the first. */
  specVersion: z.int().positive().nullable(),
  docs: z.array(DesignDocSummary),
});
export type FeatureDesignDocsView = z.infer<typeof FeatureDesignDocsView>;

export const DesignDocVersionView = z.object({
  id: Id,
  version: z.int().positive(),
  markdown: z.string(),
  source: DesignDocVersionSource,
  summary: z.string().nullable(),
  /** The Spec Version it follows. */
  specVersion: z.int().positive(),
  approvedBy: PersonRef,
  /** For a REVERT, the version whose Markdown it restored. */
  revertedFrom: z.int().positive().nullable(),
  draftedWith: RecordedModel.nullable(),
  createdAt: Timestamp,
});
export type DesignDocVersionView = z.infer<typeof DesignDocVersionView>;

/** A Design Doc proposal, with both sides of its diff. */
export const DesignDocProposalView = z.object({
  id: Id,
  featureId: Id,
  key: DesignDocKey,
  platform: PlatformRef.nullable(),
  name: z.string(),
  status: DesignDocProposalStatus,
  reason: DesignDocProposalReason,
  /** The Spec Version it was drafted from. */
  specVersion: z.int().positive(),
  /** The approved version it updates; null for a first draft. */
  baseVersion: z.int().positive().nullable(),
  baseMarkdown: z.string(),
  proposedMarkdown: z.string(),
  summary: z.string().nullable(),
  reviewedBy: PersonRef.nullable(),
  declineReason: z.string().nullable(),
  draftedWith: RecordedModel.nullable(),
  /** Whether the viewer may approve, decline or Request changes on it. */
  canReview: z.boolean(),
  createdAt: Timestamp,
});
export type DesignDocProposalView = z.infer<typeof DesignDocProposalView>;

/** `GET /features/:id/design-docs/:key`: one Design Doc with its versions, newest first. */
export const DesignDocDetailView = z.object({
  featureId: Id,
  doc: DesignDocSummary,
  versions: z.array(DesignDocVersionView),
  /** The pending proposal, if any. */
  proposal: DesignDocProposalView.nullable(),
});
export type DesignDocDetailView = z.infer<typeof DesignDocDetailView>;
