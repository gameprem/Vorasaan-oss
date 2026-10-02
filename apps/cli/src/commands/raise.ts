import * as p from '@clack/prompts';
import type { DecisionRequestView, FeatureSummaryView, TeamRole } from '@vorasaan/shared';
import type { VorasaanApi } from '../api.ts';
import {
  type DeciderHints,
  deciderHints,
  deciderRoleHint,
  defaultDeciderRole,
  discardDraft,
  draftRequest,
  featuresInScope,
  formatChoices,
  noFeaturesMessage,
  type RaiseApi,
  type RepoScope,
  ROLE_LABEL,
  sendRequest,
  sentMessage,
  toDraft,
} from './raise-flow.ts';
import { type RaiseOptions, UsageError } from './raise-options.ts';

class Cancelled extends Error {}

function answered<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

const required = (label: string) => (value: string | undefined) =>
  value?.trim() ? undefined : `${label} is required`;

export async function runRaise(
  api: RaiseApi & Pick<VorasaanApi, 'feature'>,
  options: RaiseOptions,
  scope?: RepoScope,
): Promise<void> {
  p.intro('vorasaan raise');
  let draft: DecisionRequestView | undefined;
  try {
    const picked = options.featureId ? undefined : await pickFeature(api, scope?.projectId);
    const featureId = picked?.id ?? (options.featureId as string);
    // Loaded the first time the Raiser changes the decider role.
    let hints: DeciderHints | undefined;
    const loadHints = async () => {
      const teamId =
        picked?.teamId ?? (await api.feature(featureId).catch(() => undefined))?.teamId;
      return teamId ? deciderHints(api, teamId) : {};
    };
    const kind =
      options.kind ??
      answered(
        await p.select({
          message: 'What kind of Decision Request?',
          options: [
            { value: 'BLOCKER' as const, label: 'Blocker', hint: 'my work is stopped' },
            { value: 'QUESTION' as const, label: 'Question', hint: 'I can keep working' },
          ],
        }),
      );
    const title =
      options.title ?? answered(await p.text({ message: 'Title', validate: required('A title') }));
    const description =
      options.description ??
      answered(
        await p.text({
          message: 'Describe it (what you found, what is blocked)',
          validate: required('A description'),
        }),
      );

    const spin = p.spinner();
    spin.start(options.withChoices ? 'Drafting Choices with AI…' : 'Creating…');
    const drafted = await draftRequest(
      api,
      {
        featureId,
        kind,
        title,
        description,
        withChoices: options.withChoices,
        context: { diff: options.diff, files: options.files },
      },
      scope,
    );
    draft = drafted.draft;
    spin.stop(options.withChoices ? 'Choices drafted' : 'Created');
    if (drafted.skipped.length) p.log.warn(`Context left out: ${drafted.skipped.join('; ')}`);

    let choices = draft.choices.map(toDraft);
    let deciderRole: TeamRole = defaultDeciderRole(draft, options.deciderRole);
    let edited = false;

    if (!options.yes) {
      for (;;) {
        if (choices.length) p.note(formatChoices(choices), 'Choices');
        const action = answered(
          await p.select({
            message: `Send to the ${ROLE_LABEL[deciderRole]}?`,
            options: [
              { value: 'send', label: `Send to ${ROLE_LABEL[deciderRole]}` },
              { value: 'role', label: 'Change the decider role' },
              ...(choices.length ? [{ value: 'edit', label: 'Edit a Choice' }] : []),
              { value: 'withdraw', label: 'Withdraw' },
            ],
          }),
        );
        if (action === 'send') break;
        if (action === 'withdraw') {
          await api.withdraw(draft.id);
          p.outro('Withdrawn.');
          return;
        }
        if (action === 'role') {
          hints ??= await loadHints();
          const roleHints = hints;
          deciderRole = answered(
            await p.select({
              message: 'Who should decide?',
              initialValue: deciderRole,
              options: Object.entries(ROLE_LABEL).map(([value, label]) => ({
                value: value as TeamRole,
                label,
                hint: deciderRoleHint(value as TeamRole, draft, roleHints),
              })),
            }),
          );
        }
        if (action === 'edit') {
          const index = answered(
            await p.select({
              message: 'Which Choice?',
              options: choices.map((c, i) => ({ value: i, label: `${c.label}. ${c.title}` })),
            }),
          );
          const current = choices[index];
          if (!current) continue;
          const nextTitle = answered(
            await p.text({
              message: 'Title',
              initialValue: current.title,
              validate: required('A title'),
            }),
          );
          const nextDescription = answered(
            await p.text({
              message: 'Description',
              initialValue: current.description,
              validate: required('A description'),
            }),
          );
          choices = choices.map((c, i) =>
            i === index ? { ...c, title: nextTitle, description: nextDescription } : c,
          );
          edited = true;
        }
      }
    }

    const submitted = await sendRequest(api, draft, deciderRole, edited ? choices : undefined);
    p.outro(sentMessage(submitted, deciderRole));
  } catch (error) {
    // Never leave an orphaned DRAFT behind: withdraw it on cancel or a failed submit.
    await discardDraft(api, draft);
    if (error instanceof Cancelled) {
      p.cancel(draft ? 'Cancelled. The draft was withdrawn.' : 'Cancelled.');
      return;
    }
    throw error;
  }
}

async function pickFeature(api: Pick<VorasaanApi, 'listFeatures'>, projectId?: string) {
  const features = await featuresInScope(api, projectId);
  if (features.length === 0) throw new UsageError(noFeaturesMessage(projectId));
  const id = answered(
    await p.select<string>({
      message: 'Which Feature?',
      options: features.map((f) => ({
        value: f.id,
        label: f.title,
        hint: `${f.projectName} / ${f.teamName} · ${f.myRoles.join(', ')}`,
      })),
    }),
  );
  return features.find((f) => f.id === id) as FeatureSummaryView;
}
