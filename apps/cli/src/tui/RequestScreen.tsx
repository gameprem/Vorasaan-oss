import type { DecisionRequestView, PersonRef, RequestMessageKind } from '@vorasaan/shared';
import { Box, Text, useInput } from 'ink';
import { type ReactNode, useEffect, useState } from 'react';
import { ROLE_LABEL } from '../commands/raise-flow.ts';
import type { TuiApi } from './App.tsx';
import { Confirm, Menu, ScrollText, TextInput } from './components.tsx';
import { errorMessage, requestDetail } from './format.ts';
import { type Remote, RemoteStatus, useFlash, useRemote } from './remote.tsx';

type Mode =
  | { kind: 'none' }
  | { kind: 'decide' }
  | { kind: 'answer-own' }
  | { kind: 'rationale'; pick: { choiceId: string } | { customAnswer: string } }
  | { kind: 'message'; message: RequestMessageKind }
  | { kind: 'reassign'; candidates: PersonRef[] }
  | { kind: 'withdraw' }
  | { kind: 'sending'; what: string };

const MESSAGE_PROMPT: Record<RequestMessageKind, { label: string; hint: string; done: string }> = {
  QUESTION: {
    label: 'Ask the Raiser for more info',
    hint: 'The request waits (Needs info) until the Raiser answers. Enter sends · Esc cancels',
    done: 'Asked for more info.',
  },
  ANSWER: {
    label: 'Your answer',
    hint: 'The request goes back to the Decider. Enter sends · Esc cancels',
    done: 'Answer sent.',
  },
  NOTE: { label: 'Note', hint: 'Enter adds it to the thread · Esc cancels', done: 'Note added.' },
};

/** What the viewer may do on this request, as the web decides it; the server has the last word. */
export function requestPermissions(
  r: DecisionRequestView,
  meId: string | undefined,
  actHint = false,
) {
  const isRaiser = meId !== undefined && r.raiser.id === meId;
  const isDecider = meId !== undefined && r.decider?.id === meId;
  const isRecipient = r.recipients.some((p) => p.id === meId);
  // A recipient of a request nobody has Claimed may decide or ask directly (that Claims it).
  // `actHint`: the Inbox said so (deciding as someone's Delegate).
  const canAct = !isRaiser && (isDecider || (r.decider === null && isRecipient) || actHint);
  const active = r.status === 'OPEN' || r.status === 'NEEDS_INFO';
  return {
    claim: r.status === 'OPEN' && r.canClaim,
    decide: r.status === 'OPEN' && canAct,
    ask: r.status === 'OPEN' && canAct,
    reassign: r.status === 'OPEN' && isDecider,
    answer: r.status === 'NEEDS_INFO' && isRaiser,
    note: active && (isRaiser || canAct),
    withdraw: active && isRaiser,
    proposal: r.specProposal !== null,
  };
}

export function actionHint(p: ReturnType<typeof requestPermissions>): string {
  return [
    p.decide && 'd decide',
    p.claim && 'c Claim',
    p.ask && 'i ask for info',
    p.reassign && 's reassign',
    p.answer && 'a answer',
    p.note && 'n note',
    p.withdraw && 'w withdraw',
    p.proposal && 'p Spec Proposal',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A Decision Request with every action the web offers: decide (a Choice or my own
 * words, with an optional rationale), Claim, reassign, ask for info, answer, note,
 * withdraw. While a form is open it takes the keyboard (`onCapture`).
 */
export function RequestScreen({
  api,
  id,
  height,
  meId,
  actHint,
  tick,
  onCapture,
  onChanged,
  onOpenProposal,
}: {
  api: TuiApi;
  id: string;
  height: number;
  meId: string | undefined;
  /** Opened from a DECIDE Inbox Item as someone's Delegate: the viewer may act on it. */
  actHint?: boolean;
  /** Bumped on live events: reload quietly. */
  tick: number;
  onCapture: (capturing: boolean) => void;
  onChanged: () => void;
  onOpenProposal: (proposalId: string) => void;
}) {
  const [version, setVersion] = useState(0);
  const state: Remote<DecisionRequestView> = useRemote(
    () => api.decisionRequest(id),
    id,
    `${tick}:${version}`,
  );
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [flash, setFlash] = useFlash(state);
  const capturing = mode.kind !== 'none';

  useEffect(() => {
    onCapture(capturing);
  }, [capturing, onCapture]);
  useEffect(() => () => onCapture(false), [onCapture]);

  const request = state.status === 'ok' ? state.data : undefined;
  const can = request ? requestPermissions(request, meId, actHint) : undefined;

  const run = (what: string, done: (result: unknown) => string, call: () => Promise<unknown>) => {
    setMode({ kind: 'sending', what });
    setFlash(undefined);
    call().then(
      (result) => {
        setMode({ kind: 'none' });
        setFlash({ tone: 'ok', text: done(result) });
        setVersion((v) => v + 1);
        onChanged();
      },
      (error) => {
        setMode({ kind: 'none' });
        setFlash({ tone: 'error', text: errorMessage(error) });
      },
    );
  };

  const startReassign = (r: DecisionRequestView) => {
    setMode({ kind: 'sending', what: 'Loading the Team…' });
    setFlash(undefined);
    api
      .feature(r.featureId)
      .then((feature) => api.team(feature.teamId))
      .then(
        (team) => {
          const candidates = team.members
            .filter(
              (m) =>
                m.roles.includes(r.deciderRole) && m.userId !== r.raiser.id && m.userId !== meId,
            )
            .map((m) => ({ id: m.userId, name: m.name }));
          if (candidates.length === 0) {
            setMode({ kind: 'none' });
            setFlash({
              tone: 'error',
              text: `Nobody else in the Team holds the ${ROLE_LABEL[r.deciderRole]} role, so there is no one to reassign to.`,
            });
          } else setMode({ kind: 'reassign', candidates });
        },
        (error) => {
          setMode({ kind: 'none' });
          setFlash({ tone: 'error', text: errorMessage(error) });
        },
      );
  };

  useInput(
    (input) => {
      if (!request || !can) return;
      if (input === 'd' && can.decide) setMode({ kind: 'decide' });
      else if (input === 'c' && can.claim) {
        run(
          'Claiming…',
          () => 'Claimed: you are now the Decider.',
          () => api.claim(request.id),
        );
      } else if (input === 'i' && can.ask) setMode({ kind: 'message', message: 'QUESTION' });
      else if (input === 's' && can.reassign) startReassign(request);
      else if (input === 'a' && can.answer) setMode({ kind: 'message', message: 'ANSWER' });
      else if (input === 'n' && can.note) setMode({ kind: 'message', message: 'NOTE' });
      else if (input === 'w' && can.withdraw) setMode({ kind: 'withdraw' });
      else if (input === 'p' && request.specProposal) onOpenProposal(request.specProposal.id);
      else return;
      setFlash(undefined);
    },
    { isActive: !capturing },
  );

  if (!request || !can) return <RemoteStatus state={state} />;
  const cancel = () => setMode({ kind: 'none' });

  let form: ReactNode = null;
  if (mode.kind === 'decide') {
    form = (
      <Menu<string | null>
        title="Decide: pick a Choice or answer in your own words (Esc cancels)"
        options={[
          ...request.choices.map((c) => ({
            value: c.id as string | null,
            label: `${c.label}. ${c.title}`,
            hint: `scope ${c.impactScope} · time ${c.impactTime} · risk ${c.impactRisk}`,
          })),
          { value: null, label: 'Answer in my own words' },
        ]}
        onPick={(choiceId) =>
          setMode(choiceId ? { kind: 'rationale', pick: { choiceId } } : { kind: 'answer-own' })
        }
        onCancel={cancel}
      />
    );
  } else if (mode.kind === 'answer-own') {
    form = (
      <TextInput
        key="answer-own"
        label="Your answer"
        hint="Enter continues · Esc cancels"
        validate={(v) => (v.trim() ? undefined : 'Write your answer first')}
        onSubmit={(customAnswer) =>
          setMode({ kind: 'rationale', pick: { customAnswer: customAnswer.trim() } })
        }
        onCancel={cancel}
      />
    );
  } else if (mode.kind === 'rationale') {
    const { pick } = mode;
    form = (
      <TextInput
        key="rationale"
        label="Rationale (optional)"
        hint="Why this Decision? Enter decides (empty is fine) · Esc cancels"
        onSubmit={(text) => {
          const rationale = text.trim() || undefined;
          run(
            'Deciding…',
            () => 'Decided. A Spec Proposal is drafted from it (p opens it).',
            () => api.decide(request.id, { ...pick, ...(rationale ? { rationale } : {}) }),
          );
        }}
        onCancel={cancel}
      />
    );
  } else if (mode.kind === 'message') {
    const prompt = MESSAGE_PROMPT[mode.message];
    const kind = mode.message;
    form = (
      <TextInput
        key={kind}
        label={prompt.label}
        hint={prompt.hint}
        validate={(v) => (v.trim() ? undefined : 'Write something first')}
        onSubmit={(body) =>
          run(
            'Sending…',
            () => prompt.done,
            () => api.postMessage(request.id, { kind, body: body.trim() }),
          )
        }
        onCancel={cancel}
      />
    );
  } else if (mode.kind === 'reassign') {
    form = (
      <Menu
        title={`Reassign to another ${ROLE_LABEL[request.deciderRole]} (Esc cancels)`}
        options={mode.candidates.map((p) => ({ value: p, label: p.name }))}
        onPick={(person) =>
          run(
            'Reassigning…',
            () => `Reassigned to ${person.name}.`,
            () => api.reassign(request.id, person.id),
          )
        }
        onCancel={cancel}
      />
    );
  } else if (mode.kind === 'withdraw') {
    form = (
      <Confirm
        question="Withdraw this request? Nobody will be asked to decide it any more."
        onYes={() =>
          run(
            'Withdrawing…',
            () => 'Withdrawn.',
            () => api.withdraw(request.id),
          )
        }
        onNo={cancel}
      />
    );
  } else if (mode.kind === 'sending') {
    form = <Text dimColor>{mode.what}</Text>;
  }

  const hint = actionHint(can);
  // Keep room for the form under the text.
  const textHeight = Math.max(3, height - (form ? 4 : 2));
  return (
    <Box flexDirection="column">
      <Text bold>{request.title}</Text>
      <ScrollText lines={requestDetail(request)} height={textHeight} active={!capturing} />
      {flash && (
        <Text color={flash.tone === 'ok' ? 'green' : 'red'}>
          {flash.tone === 'ok' ? '✔' : '✖'} {flash.text}
        </Text>
      )}
      {form ?? (hint ? <Text color="cyan">{hint}</Text> : null)}
    </Box>
  );
}
