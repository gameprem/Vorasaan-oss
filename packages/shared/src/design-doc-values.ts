import type { DesignTemplateKind, TeamRole } from './enums.ts';
import type { PlatformDesignTemplate } from './platform.ts';

// Plain values of design-doc.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

export const DESIGN_TEMPLATE_LABEL: Record<DesignTemplateKind, string> = {
  BACK_END: 'Back-End',
  FRONT_END: 'Front-End',
  MOBILE: 'Mobile',
  QA: 'QA',
};

/**
 * The template a Platform's Design Doc starts from: the one it names, else one chosen from its
 * Team Roles (MOBILE → Mobile, FRONTEND or DESIGNER → Front-End, anything else → Back-End).
 */
export function platformDesignTemplate(platform: {
  designTemplate?: PlatformDesignTemplate | null;
  roles: readonly TeamRole[];
}): PlatformDesignTemplate {
  if (platform.designTemplate) return platform.designTemplate;
  if (platform.roles.includes('MOBILE')) return 'MOBILE';
  if (platform.roles.includes('FRONTEND') || platform.roles.includes('DESIGNER')) {
    return 'FRONT_END';
  }
  return 'BACK_END';
}

/** The longest Design Doc template a Project may save. */
export const MAX_DESIGN_TEMPLATE_CHARS = 20_000;
