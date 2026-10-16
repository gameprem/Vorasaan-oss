import type { DecisionSource } from './enums.ts';

// Plain values of decision-request.ts, with no Zod (types only from the schemas), so the web pages
// that use them don't load Zod.

/** "decided in Slack": where a Decision was made, for the Decision Log (ticket 0058). */
export const DECISION_SOURCE_LABEL: Record<DecisionSource, string> = {
  WEB: 'the web app',
  CLI: 'the CLI',
  LINE: 'LINE',
  SLACK: 'Slack',
  TEAMS: 'Microsoft Teams',
};
