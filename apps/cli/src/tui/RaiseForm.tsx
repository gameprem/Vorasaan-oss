import type {
  DecisionRequestKind,
  DecisionRequestView,
  FeatureSummaryView,
  TeamRole,
} from '@vorasaan/shared';
import { Box, Text, useInput } from 'ink';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
} from '../commands/raise-flow.ts';
import { Menu, TextInput } from './components.tsx';
import { errorMessage } from './format.ts';

type Step =
  | 'loading'
  | 'feature'
  | 'kind'
  | 'title'
  | 'description'
  | 'diff'
  | 'files'
  | 'drafting'
  | 'review'
  | 'role'
  | 'sending'
  | 'done'
  | 'error';

type KindChoice = { kind: DecisionRequestKind; withChoices: boolean };

const KINDS: { value: KindChoice; label: string }[] = [
  { value: { kind: 'BLOCKER', withChoices: true }, label: 'Blocker: my work is stopped' },
  { value: { kind: 'QUESTION', withChoices: true }, label: 'Question with AI-drafted Choices' },
  { value: { kind: 'QUESTION', withChoices: false }, label: 'Question as plain text' },
];

const required = (what: string) => (value: string) =>
  value.trim() ? undefined : `${what} is required`;

/**
 * The TUI's raise form. It runs the same steps as `vorasaan raise` (raise-flow.ts):
 * pick a Feature in scope, describe, attach repository context, review the
 * AI-drafted Choices and the decider role, then send or withdraw the draft.
 */
export function RaiseForm({
  api,
  scope,
  initialFeatureId,
  onClose,
}: {
  api: RaiseApi;
  scope: RepoScope;
  initialFeatureId?: string;
  onClose: (sent: boolean) => void;
}) {
  const [step, setStep] = useState<Step>('loading');
  const [message, setMessage] = useState('');
  const [features, setFeatures] = useState<FeatureSummaryView[]>([]);
  const [featureId, setFeatureId] = useState<string>();
  const [kind, setKind] = useState<KindChoice>({ kind: 'BLOCKER', withChoices: true });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [diff, setDiff] = useState(false);
  const [draft, setDraft] = useState<DecisionRequestView>();
  const [skipped, setSkipped] = useState<string[]>([]);
  const [role, setRole] = useState<TeamRole>('PO');
  const [hints, setHints] = useState<DeciderHints>({});

  // Withdraw a draft that was never sent, also when the TUI quits mid-form.
  const draftRef = useRef<DecisionRequestView | undefined>(undefined);
  const sentRef = useRef(false);
  useEffect(
    () => () => {
      if (!sentRef.current) void discardDraft(api, draftRef.current);
    },
    [api],
  );

  useEffect(() => {
    let live = true;
    featuresInScope(api, scope.projectId).then(
      (list) => {
        if (!live) return;
        if (list.length === 0) {
          setMessage(noFeaturesMessage(scope.projectId));
          setStep('error');
          return;
        }
        setFeatures(list);
        setStep('feature');
      },
      (error) => {
        if (!live) return;
        setMessage(errorMessage(error));
        setStep('error');
      },
    );
    return () => {
      live = false;
    };
  }, [api, scope.projectId]);

  const cancel = async () => {
    await discardDraft(api, draftRef.current);
    draftRef.current = undefined;
    onClose(false);
  };

  const createDraft = async (files: string[]) => {
    if (!featureId) return;
    const teamId = features.find((f) => f.id === featureId)?.teamId;
    setStep('drafting');
    try {
      const [result, loadedHints] = await Promise.all([
        draftRequest(
          api,
          {
            featureId,
            kind: kind.kind,
            title,
            description,
            withChoices: kind.withChoices,
            context: { diff, files },
          },
          scope,
        ),
        teamId ? deciderHints(api, teamId) : Promise.resolve({}),
      ]);
      setHints(loadedHints);
      draftRef.current = result.draft;
      setDraft(result.draft);
      setSkipped(result.skipped);
      setRole(defaultDeciderRole(result.draft));
      setStep('review');
    } catch (error) {
      setMessage(errorMessage(error));
      setStep('error');
    }
  };

  const send = async () => {
    if (!draft) return;
    setStep('sending');
    try {
      const submitted = await sendRequest(api, draft, role);
      sentRef.current = true;
      setMessage(sentMessage(submitted, role));
      setStep('done');
    } catch (error) {
      await discardDraft(api, draftRef.current);
      draftRef.current = undefined;
      setMessage(`${errorMessage(error)} The draft was withdrawn.`);
      setStep('error');
    }
  };

  useInput(
    (_input, key) => {
      if (key.return || key.escape) onClose(step === 'done');
    },
    { isActive: step === 'done' || step === 'error' },
  );

  const feature = features.find((f) => f.id === featureId);
  let body: ReactNode;
  switch (step) {
    case 'loading':
      body = <Text dimColor>Loading your Features…</Text>;
      break;
    case 'feature':
      body = (
        <Menu
          title="Which Feature?"
          initial={Math.max(
            0,
            features.findIndex((f) => f.id === initialFeatureId),
          )}
          options={features.map((f) => ({
            value: f.id,
            label: f.title,
            hint: `${f.projectName} / ${f.teamName}`,
          }))}
          onPick={(id) => {
            setFeatureId(id);
            setStep('kind');
          }}
          onCancel={cancel}
        />
      );
      break;
    case 'kind':
      body = (
        <Menu
          title="What kind of Decision Request?"
          options={KINDS}
          onPick={(value) => {
            setKind(value);
            setStep('title');
          }}
          onCancel={cancel}
        />
      );
      break;
    case 'title':
      body = (
        <TextInput
          label="Title"
          validate={required('A title')}
          onSubmit={(value) => {
            setTitle(value.trim());
            setStep('description');
          }}
          onCancel={cancel}
        />
      );
      break;
    case 'description':
      body = (
        <TextInput
          label="Describe it"
          hint="What you found and what is blocked."
          validate={required('A description')}
          onSubmit={(value) => {
            setDescription(value.trim());
            setStep('diff');
          }}
          onCancel={cancel}
        />
      );
      break;
    case 'diff':
      body = (
        <Menu
          title="Attach the current git diff as context?"
          options={[
            { value: false, label: 'No' },
            { value: true, label: 'Yes', hint: 'secret-looking files are skipped' },
          ]}
          onPick={(value) => {
            setDiff(value);
            setStep('files');
          }}
          onCancel={cancel}
        />
      );
      break;
    case 'files':
      body = (
        <TextInput
          label="Files to attach"
          hint={`Comma-separated paths relative to ${scope.cwd ?? scope.root}; Enter for none.`}
          onSubmit={(value) =>
            createDraft(
              value
                .split(',')
                .map((f) => f.trim())
                .filter(Boolean),
            )
          }
          onCancel={cancel}
        />
      );
      break;
    case 'drafting':
      body = <Text>{kind.withChoices ? 'Drafting Choices with AI…' : 'Creating…'}</Text>;
      break;
    case 'review':
      body = (
        <Box flexDirection="column">
          {skipped.length > 0 && <Text color="yellow">Context left out: {skipped.join('; ')}</Text>}
          {draft && draft.choices.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>Choices</Text>
              <Text>{formatChoices(draft.choices.map(toDraft))}</Text>
            </Box>
          )}
          <Menu
            title={`Send to the ${ROLE_LABEL[role]}?`}
            options={[
              { value: 'send' as const, label: `Send to ${ROLE_LABEL[role]}` },
              { value: 'role' as const, label: 'Change the decider role' },
              { value: 'withdraw' as const, label: 'Withdraw' },
            ]}
            onPick={(action) => {
              if (action === 'send') void send();
              else if (action === 'role') setStep('role');
              else void cancel();
            }}
            onCancel={cancel}
          />
          <Text dimColor>To edit a Choice, use `vorasaan raise`.</Text>
        </Box>
      );
      break;
    case 'role':
      body = (
        <Menu
          title="Who should decide?"
          initial={Object.keys(ROLE_LABEL).indexOf(role)}
          options={Object.entries(ROLE_LABEL).map(([value, label]) => ({
            value: value as TeamRole,
            label,
            hint: deciderRoleHint(value as TeamRole, draft, hints),
          }))}
          onPick={(value) => {
            setRole(value);
            setStep('review');
          }}
          onCancel={() => setStep('review')}
        />
      );
      break;
    case 'sending':
      body = <Text>Sending…</Text>;
      break;
    case 'done':
      body = (
        <Box flexDirection="column">
          <Text color="green">✔ {message}</Text>
          <Text dimColor>Enter or Esc to go back.</Text>
        </Box>
      );
      break;
    case 'error':
      body = (
        <Box flexDirection="column">
          <Text color="red">✖ {message}</Text>
          <Text dimColor>Enter or Esc to go back.</Text>
        </Box>
      );
      break;
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        Raise a Decision Request{feature ? ` on "${feature.title}"` : ''}
        {title && step !== 'title' ? `: ${title}` : ''}
      </Text>
      {/* Keyed by step so each field and menu starts empty instead of reusing the last one's state. */}
      <Box key={step} flexDirection="column">
        {body}
      </Box>
      {step !== 'done' && step !== 'error' && <Text dimColor>Esc cancels.</Text>}
    </Box>
  );
}
