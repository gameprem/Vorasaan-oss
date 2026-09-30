import * as p from '@clack/prompts';
import type { ChoiceDraft, DecisionRequestView, TeamRole } from '@vorasaan/shared';
import type { VorasaanApi } from '../api.ts';
import type { RaiseOptions } from './raise-options.ts';

const ROLE_LABEL: Record<TeamRole, string> = {
  PO: 'PO',
  DESIGNER: 'Designer',
  TECH_LEAD: 'Tech Lead',
  BACKEND: 'Backend',
  FRONTEND: 'Frontend',
  MOBILE: 'Mobile',
  QA: 'QA',
};

class Cancelled extends Error {}

function answered<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

const required = (label: string) => (value: string | undefined) =>
  value?.trim() ? undefined : `${label} is required`;

function formatChoices(choices: DecisionRequestView['choices']) {
  return choices
    .map(
      (c) =>
        `${c.label}. ${c.title}\n   ${c.description}\n   scope: ${c.impactScope}\n   time:  ${c.impactTime}\n   risk:  ${c.impactRisk}`,
    )
    .join('\n\n');
}

function toDraft(c: DecisionRequestView['choices'][number]): ChoiceDraft {
  return {
    label: c.label,
    title: c.title,
    description: c.description,
    impactScope: c.impactScope,
    impactTime: c.impactTime,
    impactRisk: c.impactRisk,
  };
}

export async function runRaise(api: VorasaanApi, options: RaiseOptions): Promise<void> {
  p.intro('vorasaan raise');
  let draft: DecisionRequestView | undefined;
  try {
    const featureId = options.featureId ?? (await pickFeature(api));
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
    draft = await api.raise({
      featureId,
      kind,
      title,
      description,
      withChoices: options.withChoices,
    });
    spin.stop(options.withChoices ? 'Choices drafted' : 'Created');

    let choices = draft.choices.map(toDraft);
    let deciderRole: TeamRole = options.deciderRole ?? draft.suggestedRole ?? 'PO';
    let edited = false;

    if (!options.yes) {
      for (;;) {
        if (choices.length)
          p.note(formatChoices(draft.choices.map((c, i) => ({ ...c, ...choices[i] }))), 'Choices');
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
          deciderRole = answered(
            await p.select({
              message: 'Who should decide?',
              initialValue: deciderRole,
              options: Object.entries(ROLE_LABEL).map(([value, label]) => ({
                value: value as TeamRole,
                label,
                hint: value === draft?.suggestedRole ? 'suggested' : undefined,
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

    const submitted = await api.submit(draft.id, {
      deciderRole,
      ...(edited ? { choices } : {}),
    });
    p.outro(
      `Sent to ${submitted.decider?.name ?? 'the Decider'} (${ROLE_LABEL[deciderRole]}). Request ${submitted.id}`,
    );
  } catch (error) {
    // Never leave an orphaned DRAFT behind: withdraw it on cancel or a failed submit.
    if (draft && draft.status === 'DRAFT') await api.withdraw(draft.id).catch(() => {});
    if (error instanceof Cancelled) {
      p.cancel(draft ? 'Cancelled. The draft was withdrawn.' : 'Cancelled.');
      return;
    }
    throw error;
  }
}

async function pickFeature(api: VorasaanApi): Promise<string> {
  const features = await api.listFeatures();
  if (features.length === 0) {
    throw new Error('You are not a Role Owner on any Feature yet.');
  }
  return answered(
    await p.select({
      message: 'Which Feature?',
      options: features.map((f) => ({
        value: f.id,
        label: f.title,
        hint: `${f.projectName} / ${f.teamName} · ${f.myRoles.join(', ')}`,
      })),
    }),
  );
}
