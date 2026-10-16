// Plain values of platform.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** At most this many Platforms in a Project, or in the Organization's default list. */
export const MAX_PLATFORMS = 20;

/** The Design Doc templates a Platform can start from (`PlatformDesignTemplate`). */
export const PLATFORM_DESIGN_TEMPLATES = ['BACK_END', 'FRONT_END', 'MOBILE'] as const;

/**
 * A new Spec's starting Markdown: the usual sections, plus one `## <Platform>` section per
 * target Platform (ADR 0009), each with an empty `### Acceptance criteria` subsection for
 * QA to fill.
 */
export function specTemplate({
  title = 'Feature title',
  platforms = [],
}: {
  title?: string;
  platforms?: readonly string[];
} = {}): string {
  const sections = platforms.map((name) => `## ${name}\n\n### Acceptance criteria\n\n`).join('');
  return `# ${title}

## Goal

What problem this solves, for whom.

## User flow

1. …

## Acceptance criteria

- [ ] …

${sections}## Out of scope

- …

## Open questions

- …
`;
}
