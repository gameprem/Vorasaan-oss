// Plain values of brief.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/**
 * The empty Project Brief a new Project starts from: section headings only
 * (REQUIREMENT §3.8). It is not stored; `GET /projects/:id/brief` returns it as
 * version 0 until someone saves v1.
 */
export const BRIEF_TEMPLATE = `# Project Brief

## Business goals

## Target users

## Current capabilities

## Constraints

## Non-goals
`;
