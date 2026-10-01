import type { BriefProposalView, SpecProposalView } from '@vorasaan/shared';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { TuiApi } from './App.tsx';
import { Confirm, ScrollText } from './components.tsx';
import { diffView, errorMessage } from './format.ts';
import { RemoteStatus, useRemote } from './remote.tsx';

export type ProposalKind = 'spec' | 'brief';

type Proposal = SpecProposalView | BriefProposalView;
type Flash = { tone: 'ok' | 'error'; text: string };

const NOUN: Record<ProposalKind, { proposal: string; doc: string }> = {
  spec: { proposal: 'Spec Proposal', doc: 'Spec' },
  brief: { proposal: 'Brief Proposal', doc: 'Project Brief' },
};

/**
 * A Spec or Brief Proposal as a scrollable, colored diff against the version it was
 * drafted from, with approve (a) and reject (x, confirmed) while it is PENDING.
 */
export function ProposalScreen({
  api,
  kind,
  id,
  title,
  height,
  tick,
  onCapture,
  onChanged,
}: {
  api: TuiApi;
  kind: ProposalKind;
  id: string;
  /** The Feature or Project it is about, when the opener knows it. */
  title?: string;
  height: number;
  tick: number;
  onCapture: (capturing: boolean) => void;
  onChanged: () => void;
}) {
  const [version, setVersion] = useState(0);
  const state = useRemote<Proposal>(
    () => (kind === 'spec' ? api.specProposal(id) : api.briefProposal(id)),
    `${kind}:${id}`,
    `${tick}:${version}`,
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>();
  const noun = NOUN[kind];

  useEffect(() => {
    onCapture(confirming);
  }, [confirming, onCapture]);
  useEffect(() => () => onCapture(false), [onCapture]);

  const proposal = state.status === 'ok' ? state.data : undefined;
  const pending = proposal?.status === 'PENDING';

  const act = (approve: boolean) => {
    setBusy(true);
    setFlash(undefined);
    const call =
      kind === 'spec'
        ? approve
          ? api.approveSpecProposal(id)
          : api.rejectSpecProposal(id)
        : approve
          ? api.approveBriefProposal(id)
          : api.rejectBriefProposal(id);
    call.then(
      () => {
        setBusy(false);
        setFlash({
          tone: 'ok',
          text: approve
            ? `Approved: it is now the latest ${noun.doc} Version.`
            : `Rejected: the ${noun.doc} stays as it was.`,
        });
        setVersion((v) => v + 1);
        onChanged();
      },
      (error) => {
        setBusy(false);
        setFlash({ tone: 'error', text: errorMessage(error) });
      },
    );
  };

  useInput(
    (input) => {
      if (!pending || busy) return;
      if (input === 'a') act(true);
      else if (input === 'x') {
        setFlash(undefined);
        setConfirming(true);
      }
    },
    { isActive: !confirming },
  );

  if (!proposal) return <RemoteStatus state={state} />;
  const diff = diffView(proposal.baseMarkdown, proposal.proposedMarkdown);
  const summary = 'summary' in proposal && proposal.summary ? ` · ${proposal.summary}` : '';
  return (
    <Box flexDirection="column">
      <Text bold>
        {noun.proposal}
        {title ? ` · ${title}` : ''}
        <Text dimColor>
          {' '}
          ({proposal.source.toLowerCase()}) · {proposal.status.toLowerCase()} · against {noun.doc} v
          {proposal.baseVersion ?? 0} · {proposal.approver.name} approves{summary}
        </Text>
      </Text>
      <Text>
        <Text color="green">+{diff.added}</Text> <Text color="red">-{diff.removed}</Text>
      </Text>
      <ScrollText
        lines={diff.lines.length ? diff.lines : [{ text: 'No change.', dim: true }]}
        height={Math.max(3, height - 3)}
        active={!confirming}
      />
      {flash && (
        <Text color={flash.tone === 'ok' ? 'green' : 'red'}>
          {flash.tone === 'ok' ? '✔' : '✖'} {flash.text}
        </Text>
      )}
      {confirming ? (
        <Confirm
          question={`Reject this ${noun.proposal}?`}
          onYes={() => {
            setConfirming(false);
            act(false);
          }}
          onNo={() => setConfirming(false)}
        />
      ) : busy ? (
        <Text dimColor>Sending…</Text>
      ) : pending ? (
        <Text color="cyan">a approve · x reject</Text>
      ) : null}
    </Box>
  );
}
