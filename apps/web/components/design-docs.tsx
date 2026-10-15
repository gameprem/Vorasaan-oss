'use client';

import type {
  DesignDocProposalView,
  DesignDocState,
  DesignDocSummary,
  ProposalRedraftsView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
  useTransition,
} from 'react';
import {
  approveDesignDoc,
  type DesignDocActionResult,
  declineDesignDoc,
  draftDesignDoc,
} from '@/lib/design-doc-actions';
import { sectionPointers } from '@/lib/redrafts';
import { ProposalRedrafts } from './redrafts';
import { field } from './ui';
import { Button } from './ui/button';

// Design Docs (ADR 0014, ticket 0069): one per target Platform of a Feature, and one for QA,
// drafted by the AI from the approved Spec. Who approves one (a Tech Lead or a Role Owner of
// its Platform's Team Roles) approves, declines or Requests changes here; everyone else reads.
// Messages go to one status line and one alert line that stay on the page, so a re-render
// after an action never takes its message with it.

const STATE_LABEL: Record<DesignDocState, string> = {
  WAITING: 'Waiting',
  READY: 'Ready to draft',
  DRAFTING: 'Drafting…',
  PROPOSED: 'Waiting for approval',
  APPROVED: 'Approved',
  STALE: 'Stale',
};

const STATE_TONE: Record<DesignDocState, string> = {
  WAITING: 'bg-surface text-fg-soft',
  READY: 'bg-surface text-fg',
  DRAFTING: 'bg-surface text-fg',
  PROPOSED: 'bg-saffron-wash text-fg',
  APPROVED: 'bg-jade-wash text-fg',
  STALE: 'bg-saffron-wash text-fg',
};

export function DesignDocStateBadge({ state }: { state: DesignDocState }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-sm font-semibold ${STATE_TONE[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** While a Design Doc is drafting, the page refreshes until the draft is in. */
export function RefreshWhileDrafting({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const poll = setInterval(() => router.refresh(), 1500);
    return () => clearInterval(poll);
  }, [active, router]);
  return null;
}

type Message = { ok: boolean; text: string } | null;

/**
 * Where a page's Design Doc actions report, when the component that ran one can leave the
 * page with its result: declining a draft removes the review form on refresh.
 */
const MessagesContext = createContext<{
  message: Message;
  setMessage: (message: Message) => void;
} | null>(null);

/** One status line and one alert line for every Design Doc action inside it. */
export function DesignDocMessages({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<Message>(null);
  return (
    <MessagesContext.Provider value={{ message, setMessage }}>
      <Messages message={message} />
      {children}
    </MessagesContext.Provider>
  );
}

function useResult() {
  const [pending, start] = useTransition();
  const shared = useContext(MessagesContext);
  const [own, setOwn] = useState<Message>(null);
  const message = shared ? shared.message : own;
  const setMessage = shared ? shared.setMessage : setOwn;
  const run = (action: () => Promise<DesignDocActionResult>, done: string, onOk?: () => void) =>
    start(async () => {
      setMessage(null);
      const result = await action();
      if (result.error) setMessage({ ok: false, text: result.error });
      else {
        setMessage({ ok: true, text: done });
        onOk?.();
      }
    });
  return { pending, message, run, shared: shared !== null };
}

/** The stable status and alert lines of an action. */
function Messages({ message }: { message: Message }) {
  return (
    <>
      <p role="status" className="mt-2 text-sm text-jade empty:hidden">
        {message?.ok ? message.text : ''}
      </p>
      <p role="alert" className="mt-2 text-sm text-lacquer empty:hidden">
        {message && !message.ok ? message.text : ''}
      </p>
    </>
  );
}

/** "Draft it now": for an approver, when a draft is due but none is written (failed, declined). */
export function DraftDesignDocButton({
  featureId,
  doc,
}: {
  featureId: string;
  doc: DesignDocSummary;
}) {
  const action = useResult();
  return (
    <div>
      <Button
        size="sm"
        isDisabled={action.pending}
        onPress={() =>
          action.run(
            () => draftDesignDoc(featureId, doc.key),
            `The AI is drafting the ${doc.name} Design Doc.`,
          )
        }
      >
        {action.pending ? 'Asking…' : `Draft the ${doc.name} Design Doc`}
      </Button>
      {!action.shared && <Messages message={action.message} />}
    </div>
  );
}

/**
 * Approve, Decline (with an optional reason) and Request changes on a pending Design Doc
 * proposal, for its approvers. Approve names the Redraft it approves.
 */
export function ReviewDesignDoc({
  featureId,
  proposal,
  redrafts,
}: {
  featureId: string;
  proposal: DesignDocProposalView;
  redrafts: ProposalRedraftsView;
}) {
  const router = useRouter();
  const action = useResult();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const what = redrafts.current > 1 ? `Redraft ${redrafts.current}` : 'this Design Doc';
  return (
    <section aria-label="Review" className="mt-6">
      {proposal.canReview ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              isDisabled={action.pending || redrafts.writing}
              onPress={() =>
                action.run(
                  () => approveDesignDoc(featureId, proposal.key, proposal.id, redrafts.current),
                  `The ${proposal.name} Design Doc is approved.`,
                  () => router.refresh(),
                )
              }
            >
              {redrafts.current > 1 ? `Approve Redraft ${redrafts.current}` : 'Approve'}
            </Button>
            <Button isDisabled={action.pending} onPress={() => setDeclining(!declining)}>
              Decline…
            </Button>
          </div>
          {redrafts.writing && (
            <p className="mt-2 text-sm text-fg-soft">
              Writing Redraft {redrafts.current + 1}… Approve once it is ready.
            </p>
          )}
          {declining && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                action.run(
                  () => declineDesignDoc(featureId, proposal.key, proposal.id, reason),
                  `The ${proposal.name} Design Doc draft is declined.`,
                  () => {
                    setDeclining(false);
                    router.refresh();
                  },
                );
              }}
            >
              <div className="grow">
                <label htmlFor={reasonId} className="text-sm">
                  Why (optional; the AI learns from it)
                </label>
                <input
                  id={reasonId}
                  className={field}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <Button type="submit" variant="danger" isDisabled={action.pending}>
                Decline {what}
              </Button>
            </form>
          )}
          <div className="mt-4">
            <ProposalRedrafts
              kind="DESIGN_DOC_PROPOSAL"
              proposalId={proposal.id}
              redrafts={redrafts}
              pointers={sectionPointers(proposal.proposedMarkdown)}
            />
          </div>
        </>
      ) : (
        <p className="text-fg-soft">
          Waiting for a Tech Lead or a Role Owner of {proposal.name} to review it.
        </p>
      )}
      {!action.shared && <Messages message={action.message} />}
    </section>
  );
}

/** A link to a Design Doc's own page. */
export function DesignDocLink({
  featureId,
  doc,
  children,
}: {
  featureId: string;
  doc: DesignDocSummary;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`/features/${featureId}/design-docs/${doc.key}`}
      className="font-medium underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}
