import type {
  ChoiceDraft,
  DecisionRequestKind,
  DecisionRequestView,
  FeatureSummaryView,
  TeamRole,
} from '@vorasaan/shared';
import type { VorasaanApi } from '../api.ts';
import { collectRepoContext, describeWithContext, type RepoContextInput } from './repo-context.ts';

/**
 * The steps of raising a Decision Request, shared by `vorasaan raise` (clack
 * prompts) and the TUI's raise form (Ink): list the Features in scope, draft
 * (with repository context and AI Choices), then send or withdraw the draft.
 */

export const ROLE_LABEL: Record<TeamRole, string> = {
  PO: 'PO',
  DESIGNER: 'Designer',
  TECH_LEAD: 'Tech Lead',
  BACKEND: 'Backend',
  FRONTEND: 'Frontend',
  MOBILE: 'Mobile',
  QA: 'QA',
};

export type RaiseApi = Pick<
  VorasaanApi,
  'listFeatures' | 'raise' | 'submit' | 'withdraw' | 'me' | 'myTeams'
>;

/** Where the Raiser is: the repository root and, when `vorasaan init` bound it, its Project. */
export type RepoScope = { root: string; cwd?: string; projectId?: string };

/** Features where I'm a Role Owner, limited to the repo's bound Project when there is one. */
export async function featuresInScope(
  api: Pick<VorasaanApi, 'listFeatures'>,
  projectId?: string,
): Promise<FeatureSummaryView[]> {
  const features = await api.listFeatures();
  return projectId ? features.filter((f) => f.projectId === projectId) : features;
}

export function noFeaturesMessage(projectId?: string): string {
  return projectId
    ? 'You are not a Role Owner on any Feature of the Project this repository is bound to (.vorasaan/config.json).'
    : 'You are not a Role Owner on any Feature yet.';
}

export type DraftInput = {
  featureId: string;
  kind: DecisionRequestKind;
  title: string;
  description: string;
  withChoices: boolean;
  context?: RepoContextInput;
};

/** Creates the DRAFT (the server drafts Choices); returns it with what context was left out. */
export async function draftRequest(
  api: RaiseApi,
  input: DraftInput,
  scope?: RepoScope,
): Promise<{ draft: DecisionRequestView; skipped: string[] }> {
  const wantsContext = input.context && (input.context.diff || input.context.files?.length);
  const context =
    wantsContext && scope
      ? await collectRepoContext(scope.root, input.context ?? {}, scope.cwd)
      : { markdown: '', skipped: [] };
  const draft = await api.raise({
    featureId: input.featureId,
    kind: input.kind,
    title: input.title,
    description: describeWithContext(input.description, context),
    withChoices: input.withChoices,
  });
  return { draft, skipped: context.skipped };
}

export function toDraft(c: DecisionRequestView['choices'][number]): ChoiceDraft {
  return {
    label: c.label,
    title: c.title,
    description: c.description,
    impactScope: c.impactScope,
    impactTime: c.impactTime,
    impactRisk: c.impactRisk,
  };
}

export function formatChoices(choices: ChoiceDraft[]): string {
  return choices
    .map(
      (c) =>
        `${c.label}. ${c.title}\n   ${c.description}\n   scope: ${c.impactScope}\n   time:  ${c.impactTime}\n   risk:  ${c.impactRisk}`,
    )
    .join('\n\n');
}

/** Per Team Role: who else in the Team holds it, as a hint for the decider role picker. */
export type DeciderHints = Partial<Record<TeamRole, string>>;

/**
 * Who could decide, for each Team Role, in the Feature's Team: the other members holding
 * it (the Raiser is never a Recipient). Loaded with one GET /me/teams; the hints are a
 * nicety, so they are empty when that fails or the Team is not one of mine.
 */
export async function deciderHints(
  api: Pick<VorasaanApi, 'me' | 'myTeams'>,
  teamId: string,
): Promise<DeciderHints> {
  try {
    const [me, teams] = await Promise.all([api.me(), api.myTeams()]);
    const team = teams.find((t) => t.id === teamId);
    if (!team) return {};
    const hints: DeciderHints = {};
    for (const role of Object.keys(ROLE_LABEL) as TeamRole[]) {
      const names = team.members
        .filter((m) => m.userId !== me.id && m.roles.includes(role))
        .map((m) => m.name);
      hints[role] = names.length ? names.join(', ') : 'nobody else in the Team';
    }
    return hints;
  } catch {
    return {};
  }
}

/** The hint shown next to a Team Role in the decider role picker. */
export function deciderRoleHint(
  role: TeamRole,
  draft: DecisionRequestView | undefined,
  hints: DeciderHints,
): string | undefined {
  const parts = [role === draft?.suggestedRole ? 'suggested' : undefined, hints[role]];
  return parts.filter(Boolean).join(' · ') || undefined;
}

export function defaultDeciderRole(draft: DecisionRequestView, override?: TeamRole): TeamRole {
  return override ?? draft.suggestedRole ?? 'PO';
}

/** Sends the DRAFT; edited Choices are sent only when the Raiser changed them. */
export function sendRequest(
  api: RaiseApi,
  draft: DecisionRequestView,
  deciderRole: TeamRole,
  editedChoices?: ChoiceDraft[],
): Promise<DecisionRequestView> {
  return api.submit(draft.id, {
    deciderRole,
    ...(editedChoices ? { choices: editedChoices } : {}),
  });
}

/** Never leave an orphaned DRAFT behind (cancel or a failed submit). */
export async function discardDraft(api: RaiseApi, draft: DecisionRequestView | undefined) {
  if (draft && draft.status === 'DRAFT') await api.withdraw(draft.id).catch(() => {});
}

export function sentMessage(submitted: DecisionRequestView, deciderRole: TeamRole): string {
  const to = submitted.decider?.name ?? submitted.recipients.map((r) => r.name).join(', ');
  return `Sent to ${to} (${ROLE_LABEL[deciderRole]}). Request ${submitted.id}`;
}
