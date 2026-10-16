import { z } from 'zod';
import { TeamRole } from './enums.ts';
import { MAX_PLATFORMS, PLATFORM_DESIGN_TEMPLATES } from './platform-values.ts';

const Id = z.uuid();

/**
 * A Platform's name, used as its Spec section's `##` heading (ADR 0009): one line, and
 * unique in its list ignoring case, since a section matches its name case-insensitively.
 */
export const PlatformName = z
  .string()
  .trim()
  .min(1, 'Give the Platform a name')
  .max(40)
  .regex(/^[^\r\n#]+$/, 'A Platform name is one line, without "#"');

/**
 * The Design Doc templates a Platform can start from (ticket 0069). QA is not a Platform
 * (ADR 0009): its Design Doc has a template of its own.
 */
export const PlatformDesignTemplate = z.enum(PLATFORM_DESIGN_TEMPLATES);
export type PlatformDesignTemplate = z.infer<typeof PlatformDesignTemplate>;

/**
 * What a Platform is (ADR 0009): its name, the Team Roles who can answer for it, and the
 * Coverage checks it switches on. A template switches every check on.
 */
export const PlatformDefinition = z.object({
  name: PlatformName,
  /** Who can answer for it, for "Someone to ask" (Back-End: BACKEND; Flutter: MOBILE). */
  roles: z
    .array(TeamRole)
    .max(TeamRole.options.length)
    .transform((roles) => [...new Set(roles)]),
  /** The Spec has a non-empty `## <name>` section. */
  specSection: z.boolean().default(true),
  /** Someone in the Feature's Team holds one of `roles`. */
  someoneToAsk: z.boolean().default(true),
  /** No open Blocker is about the Platform. */
  noOpenBlockers: z.boolean().default(true),
  /** Its section has acceptance criteria or test cases, and someone in the Team holds QA. */
  qaReady: z.boolean().default(true),
  /**
   * The Design Doc template it starts from (ticket 0069), so a Platform added later, such as
   * Flutter, names one. Null: chosen from its Team Roles (`platformDesignTemplate`).
   */
  designTemplate: PlatformDesignTemplate.nullable().default(null),
});
export type PlatformDefinition = z.infer<typeof PlatformDefinition>;
export type PlatformDefinitionInput = z.input<typeof PlatformDefinition>;

/** The built-in template (ADR 0009): the Organization default until an Admin saves one. */
export const BUILT_IN_PLATFORMS: readonly PlatformDefinition[] = [
  { name: 'Back-End', roles: ['BACKEND'] },
  { name: 'Front-End', roles: ['FRONTEND'] },
  { name: 'Mobile', roles: ['MOBILE'] },
].map((p) => ({
  ...p,
  roles: p.roles as TeamRole[],
  // Chosen from the roles: Back-End, Front-End and Mobile.
  designTemplate: null,
  specSection: true,
  someoneToAsk: true,
  noOpenBlockers: true,
  qaReady: true,
}));

/** The names in a list must differ ignoring case. */
function uniqueNames(list: { name: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const [i, { name }] of list.entries()) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `Two Platforms are named "${name}"`,
        path: [i, 'name'],
      });
    }
    seen.add(key);
  }
}

// ─── A Project's Platforms ────────────────────────────────────────────────

export const PlatformView = PlatformDefinition.extend({ id: Id, position: z.int().nonnegative() });
export type PlatformView = z.infer<typeof PlatformView>;

/** `GET /projects/:id/platforms`, in order (everyone in the Organization reads it). */
export const ProjectPlatformsView = z.object({
  projectId: Id,
  /** Whether the reader may change the list: Admins and the POs of the Project's Teams. */
  canEdit: z.boolean(),
  platforms: z.array(PlatformView),
});
export type ProjectPlatformsView = z.infer<typeof ProjectPlatformsView>;

/**
 * One Platform of the Project's list. Keep `id` to update one in place (the Features that
 * target it keep doing so, even after a rename); leave it out to add one.
 */
export const ProjectPlatformInput = PlatformDefinition.extend({ id: Id.optional() });
export type ProjectPlatformInput = z.infer<typeof ProjectPlatformInput>;

/**
 * `PUT /projects/:id/platforms`: the whole ordered list. Leaving out a Platform removes it,
 * which is refused while Features target it (409 PlatformsInUse).
 */
export const ProjectPlatformsInput = z.object({
  platforms: z.array(ProjectPlatformInput).max(MAX_PLATFORMS).superRefine(uniqueNames),
});
export type ProjectPlatformsInput = z.infer<typeof ProjectPlatformsInput>;

/** The 409 for removing Platforms that Features target: it names those Features. */
export const PlatformsInUse = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  features: z.array(
    z.object({ id: Id, title: z.string(), platformId: Id, platformName: z.string() }),
  ),
});
export type PlatformsInUse = z.infer<typeof PlatformsInUse>;

// ─── The Organization's default ───────────────────────────────────────────

/** `GET /settings/platform-template` (every member reads it; Admins replace it). */
export const PlatformTemplateView = z.object({
  organizationId: Id,
  /** True until an Admin saves the Organization's own list: the built-in template applies. */
  builtIn: z.boolean(),
  platforms: z.array(PlatformDefinition),
});
export type PlatformTemplateView = z.infer<typeof PlatformTemplateView>;

/**
 * `PUT /settings/platform-template`: the whole ordered default list, copied into each new
 * Project. It never rewrites existing Projects.
 */
export const PlatformTemplateInput = z.object({
  platforms: z
    .array(PlatformDefinition)
    .min(1, 'The default needs at least one Platform')
    .max(MAX_PLATFORMS)
    .superRefine(uniqueNames),
});
export type PlatformTemplateInput = z.infer<typeof PlatformTemplateInput>;

// ─── A Feature's target Platforms ─────────────────────────────────────────

/** A target Platform of a Feature, as the Feature shows it. */
export const PlatformRef = z.object({ id: Id, name: z.string() });
export type PlatformRef = z.infer<typeof PlatformRef>;

/** `PUT /features/:id/platforms`: the Platforms of its own Project it targets. */
export const SetFeaturePlatformsInput = z.object({
  platformIds: z
    .array(Id)
    .max(MAX_PLATFORMS)
    .transform((ids) => [...new Set(ids)]),
});
export type SetFeaturePlatformsInput = z.infer<typeof SetFeaturePlatformsInput>;

/** `GET /features/:id/spec-template`: what a Feature's first Spec starts from. */
export const SpecTemplateView = z.object({ markdown: z.string() });
export type SpecTemplateView = z.infer<typeof SpecTemplateView>;
