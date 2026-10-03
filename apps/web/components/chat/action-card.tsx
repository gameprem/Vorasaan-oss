'use client';

import type {
  ActionCardDetail,
  ActionCardView,
  PersonRef,
  ProposalKind,
  RequestChangesInput,
} from '@vorasaan/shared';
import Link from 'next/link';
import { useId, useState } from 'react';
import { postJson } from '@/lib/chat-client';
import { choicePointers, type PointerOption, sectionPointers } from '@/lib/redrafts';
import { RedraftHistory, RequestChanges, useRedrafts } from '../redrafts';
import { SpecDiff } from '../spec-diff';
import { ROLE_LABEL } from '../ui';

// An Action Card (ADR 0008): what the AI proposed in a Conversation, with the buttons to
// approve, edit or decline it. Pressing one calls the same services the forms call; nothing
// changes until a person does. A soft shadow instead of a border, as in the mockup.

const KIND_LABEL: Record<ActionCardView['kind'], string> = {
  DECISION_REQUEST: 'Decision Request draft',
  SPEC_PROPOSAL: 'Spec Proposal',
  BRIEF_PROPOSAL: 'Brief Proposal',
  FEATURE_SUGGESTION: 'Feature Suggestion',
};

const LEVEL = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' } as const;

/** The proposal a card's target is, for its Redrafts (ticket 0065). */
const PROPOSAL_KIND: Record<ActionCardView['kind'], ProposalKind> = {
  DECISION_REQUEST: 'CHOICES',
  SPEC_PROPOSAL: 'SPEC_PROPOSAL',
  BRIEF_PROPOSAL: 'BRIEF_PROPOSAL',
  FEATURE_SUGGESTION: 'FEATURE_SUGGESTION',
};

/** The parts of what a card proposes that Request changes can point at. */
function pointersOf(detail: ActionCardDetail): PointerOption[] {
  switch (detail.kind) {
    case 'DECISION_REQUEST':
      return choicePointers(detail.choices);
    case 'SPEC_PROPOSAL':
    case 'BRIEF_PROPOSAL':
      return sectionPointers(detail.proposedMarkdown);
    case 'FEATURE_SUGGESTION':
      return [];
  }
}

/** A card's Redrafts, loaded when the person opens them. */
function CardRedrafts({ card }: { card: ActionCardView }) {
  const { redrafts, error } = useRedrafts(
    PROPOSAL_KIND[card.kind],
    card.targetId,
    `${card.redraft?.current}:${card.redraft?.writing}`,
  );
  if (error) return <p className="card-error">{error}</p>;
  if (!redrafts) return <p className="meta">Loading the Redrafts…</p>;
  return <RedraftHistory redrafts={redrafts} />;
}

const names = (people: PersonRef[]) =>
  people.length <= 1
    ? (people[0]?.name ?? '')
    : `${people
        .slice(0, -1)
        .map((p) => p.name)
        .join(', ')} and ${people.at(-1)?.name}`;

/** The state pill: PROPOSED, APPROVED, DECLINED or STALE, with what it meant for this kind. */
function stateText(card: ActionCardView): string {
  const d = card.detail;
  switch (card.status) {
    case 'PROPOSED':
      return 'Proposed';
    case 'APPROVED':
      if (d?.kind === 'SPEC_PROPOSAL' && d.version) return `Approved · Spec v${d.version}`;
      if (d?.kind === 'BRIEF_PROPOSAL' && d.version) return `Approved · Brief v${d.version}`;
      if (card.kind === 'DECISION_REQUEST') return 'Approved · sent';
      if (card.kind === 'FEATURE_SUGGESTION') return 'Approved · Feature created';
      return 'Approved';
    case 'DECLINED':
      if (card.kind === 'DECISION_REQUEST') return 'Declined · discarded';
      if (card.kind === 'FEATURE_SUGGESTION') return 'Declined · dismissed';
      return 'Declined · rejected';
    case 'STALE':
      return 'Stale';
  }
}

/** Who must approve a proposal, when it isn't the viewer. */
function otherApprover(detail: ActionCardDetail | null, meId: string): PersonRef | null {
  if (detail?.kind !== 'SPEC_PROPOSAL' && detail?.kind !== 'BRIEF_PROPOSAL') return null;
  return detail.approver.id === meId ? null : detail.approver;
}

export function ActionCard({
  card,
  meId,
  onChange,
}: {
  card: ActionCardView;
  meId: string;
  /** The card after approving or declining it (or the server says it moved on). */
  onChange: (card: ActionCardView | null) => void;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [showRedrafts, setShowRedrafts] = useState(false);
  const { detail, redraft } = card;
  const proposed = card.status === 'PROPOSED';
  const waitingFor = proposed ? otherApprover(detail, meId) : null;
  // A Redraft being written: Approve and Request changes wait for it (0065).
  const writing = redraft?.writing === true;
  /** Approve applies the Redraft the person sees, or nothing (409). */
  const seen = redraft ? { redraft: redraft.current } : {};

  const requestChanges = async (input: RequestChangesInput) => {
    setError(null);
    const res = await postJson<ActionCardView>(
      `/api/action-cards/${card.id}/request-changes`,
      input,
    );
    if (res.ok) onChange(res.data);
    return res;
  };

  /** Request changes, for whoever may approve what the card proposes. */
  function changes() {
    if (!detail || !proposed || waitingFor) return null;
    return (
      <RequestChanges
        send={requestChanges}
        pointers={pointersOf(detail)}
        left={redraft?.left}
        disabled={busy !== null || writing}
        buttonClassName="btn"
      />
    );
  }

  const act = async (action: 'approve' | 'decline', body?: unknown) => {
    setBusy(action);
    setError(null);
    const res = await postJson<ActionCardView>(`/api/action-cards/${card.id}/${action}`, body);
    setBusy(null);
    if (res.ok) {
      setDismissing(false);
      onChange(res.data);
    } else {
      setError(res.message);
      // A 409 means it was acted on, or changed, elsewhere: reload what it is now.
      if (res.status === 409) onChange(null);
    }
  };

  const pillClass =
    card.status === 'APPROVED'
      ? 'pill state done'
      : waitingFor
        ? 'pill state wait'
        : card.status === 'STALE' || card.status === 'DECLINED'
          ? 'pill state muted'
          : 'pill state';

  return (
    <article className="action-card" aria-labelledby={titleId} data-status={card.status}>
      <div className="card-head">
        <span className="kind">{KIND_LABEL[card.kind]}</span>
        {detail?.kind === 'DECISION_REQUEST' &&
          (detail.requestKind === 'BLOCKER' ? (
            <span className="pill blocker">
              <span aria-hidden>● </span>Blocker
            </span>
          ) : (
            <span className="pill">Question</span>
          ))}
        {(detail?.kind === 'SPEC_PROPOSAL' || detail?.kind === 'BRIEF_PROPOSAL') && (
          <span className="meta">
            {detail.baseVersion
              ? `against ${detail.kind === 'SPEC_PROPOSAL' ? 'Spec' : 'Brief'} v${detail.baseVersion}`
              : `the first ${detail.kind === 'SPEC_PROPOSAL' ? 'Spec' : 'Project Brief'}`}
          </span>
        )}
        {redraft && redraft.current > 1 && <span className="meta">Redraft {redraft.current}</span>}
        <span className={pillClass}>
          {waitingFor ? `Waiting for ${waitingFor.name}` : stateText(card)}
        </span>
      </div>

      <div className="card-body">
        <h3 id={titleId}>{card.title}</h3>
        {card.summary && card.kind !== 'FEATURE_SUGGESTION' && (
          <p className="card-summary">{card.summary}</p>
        )}
        {!detail && <p className="meta">What this card proposed no longer exists.</p>}
        {detail && <Body detail={detail} />}
        {writing && (
          <p className="meta" role="status">
            Writing Redraft {(redraft?.current ?? 1) + 1}…
          </p>
        )}
        {redraft && redraft.current > 1 && (
          <>
            <button
              type="button"
              className="btn"
              aria-expanded={showRedrafts}
              onClick={() => setShowRedrafts((v) => !v)}
            >
              {showRedrafts ? 'Hide the Redrafts' : 'Compare Redrafts'}
            </button>
            {showRedrafts && <CardRedrafts card={card} />}
          </>
        )}
        {card.status === 'STALE' && (
          <p className="meta">
            What it proposes changed elsewhere, so it can no longer be approved or declined.
          </p>
        )}
        {error && (
          <p role="alert" className="card-error">
            {error}
          </p>
        )}
      </div>

      {foot()}
    </article>
  );

  function foot() {
    if (!detail) return null;
    if (detail.kind === 'DECISION_REQUEST') {
      const editHref = `/requests/${card.targetId}`;
      if (!proposed) {
        return card.status === 'APPROVED' ? (
          <div className="card-foot">
            <Link className="btn" href={editHref}>
              Open the Decision Request
            </Link>
          </div>
        ) : null;
      }
      const nobody = detail.recipients.length === 0;
      return (
        <div className="card-foot">
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null || nobody || writing}
            onClick={() => act('approve', seen)}
          >
            {busy === 'approve'
              ? 'Sending…'
              : detail.recipients.length === 1
                ? `Send to ${detail.recipients[0]?.name}`
                : 'Send'}
          </button>
          <Link className="btn" href={editHref}>
            Edit
          </Link>
          {detail.choices.length > 0 && changes()}
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => act('decline')}
          >
            {busy === 'decline' ? 'Discarding…' : 'Discard'}
          </button>
          <span className="hint">Nothing is sent until you press Send</span>
        </div>
      );
    }

    if (detail.kind === 'SPEC_PROPOSAL' || detail.kind === 'BRIEF_PROPOSAL') {
      const doc = detail.kind === 'SPEC_PROPOSAL' ? 'Spec' : 'Brief';
      if (!proposed) return null;
      if (waitingFor) {
        return (
          <div className="card-foot">
            <span className="hint start">
              Only {waitingFor.name} can approve or reject it. It waits in their Inbox.
            </span>
          </div>
        );
      }
      return (
        <div className="card-foot">
          <button
            type="button"
            className="btn approve"
            disabled={busy !== null || writing}
            onClick={() => act('approve', seen)}
          >
            {busy === 'approve'
              ? 'Approving…'
              : redraft && redraft.current > 1
                ? `Approve Redraft ${redraft.current}`
                : `Approve ${doc} change`}
          </button>
          {changes()}
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => act('decline')}
          >
            {busy === 'decline' ? 'Rejecting…' : 'Reject'}
          </button>
          <span className="hint">
            Approving writes {doc} v{(detail.baseVersion ?? 0) + 1}
          </span>
        </div>
      );
    }

    // A Feature Suggestion.
    if (!proposed) {
      return card.status === 'APPROVED' && detail.featureId ? (
        <div className="card-foot">
          <Link className="btn" href={`/features/${detail.featureId}`}>
            Open the Feature
          </Link>
        </div>
      ) : null;
    }
    if (dismissing) {
      return (
        <form
          className="card-foot"
          onSubmit={(e) => {
            e.preventDefault();
            act('decline', reason.trim() ? { reason: reason.trim() } : undefined);
          }}
        >
          <label className="sr-only" htmlFor={`${titleId}-reason`}>
            Why dismiss it?
          </label>
          <input
            id={`${titleId}-reason`}
            className="card-input"
            placeholder="Why dismiss it? The AI reads this next time."
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDismissing(false);
            }}
            // biome-ignore lint/a11y/noAutofocus: the field the Dismiss button just opened
            autoFocus
          />
          <button type="submit" className="btn primary" disabled={busy !== null}>
            {busy === 'decline' ? 'Dismissing…' : 'Dismiss'}
          </button>
          <button type="button" className="btn" onClick={() => setDismissing(false)}>
            Cancel
          </button>
        </form>
      );
    }
    return (
      <div className="card-foot">
        <button
          type="button"
          className="btn primary"
          disabled={busy !== null || writing}
          onClick={() => act('approve', seen)}
        >
          {busy === 'approve' ? 'Accepting…' : 'Accept'}
        </button>
        {changes()}
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => setDismissing(true)}
        >
          Dismiss
        </button>
        <span className="hint">Accepting makes it a Feature</span>
      </div>
    );
  }
}

function Body({ detail }: { detail: ActionCardDetail }) {
  switch (detail.kind) {
    case 'DECISION_REQUEST':
      return (
        <>
          {detail.choices.length > 0 && (
            <ol className="choices" aria-label="Choices">
              {detail.choices.map((c) => (
                <li key={c.label} className="choice">
                  <span className="l" aria-hidden>
                    {c.label}
                  </span>
                  <div>
                    <b>
                      <span className="sr-only">{c.label}. </span>
                      {c.title}
                    </b>
                    <div>{c.description}</div>
                    <div className="impact">
                      <span>Scope: {c.impactScope}</span>
                      <span>Time: {c.impactTime}</span>
                      <span>Risk: {c.impactRisk}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="meta">
            Decider: <b>{ROLE_LABEL[detail.deciderRole]}</b> (suggested) ·{' '}
            {detail.recipients.length === 0 ? (
              <>nobody but you holds that Team Role here. Edit it to send it to another role.</>
            ) : detail.recipients.length === 1 ? (
              <>
                goes to <b>{detail.recipients[0]?.name}</b>
              </>
            ) : (
              <>
                goes to <b>{names(detail.recipients)}</b>; the first to Claim it decides
              </>
            )}
          </p>
        </>
      );
    case 'SPEC_PROPOSAL':
    case 'BRIEF_PROPOSAL':
      return <SpecDiff before={detail.baseMarkdown} after={detail.proposedMarkdown} />;
    case 'FEATURE_SUGGESTION':
      return (
        <>
          <p>{detail.rationale}</p>
          <p className="meta">
            <b>Business value:</b> {detail.businessValue}
          </p>
          <p className="meta">
            Effort: <b>{LEVEL[detail.effort]}</b> · Risk: <b>{LEVEL[detail.risk]}</b>
          </p>
          {detail.dismissReason && (
            <p className="meta">Dismissed because: {detail.dismissReason}</p>
          )}
        </>
      );
  }
}
