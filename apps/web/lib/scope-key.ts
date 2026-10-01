import type { ConversationScopeView } from '@vorasaan/shared';

/** "f:<featureId>" or "p:<projectId>": one key per Conversation scope, e.g. in a <select>. */
export const scopeKey = (scope: ConversationScopeView) =>
  scope.kind === 'FEATURE' ? `f:${scope.feature.id}` : `p:${scope.project.id}`;
