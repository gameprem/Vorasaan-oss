'use client';

import type {
  ActionCardView,
  AiModelsView,
  ConversationMessageView,
  ConversationReplyFailed,
  ConversationScopeView,
  ConversationTurnView,
  ConversationView,
} from '@vorasaan/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { postJson } from '@/lib/chat-client';
import { onConversationEvent } from '@/lib/conversation-events';
import type { AttachmentOwner } from '@/lib/ids';
import type { Lang } from '@/lib/lang';
import { DocIcon, Spark } from '../icons';
import { ActionCard } from './action-card';
import { Composer } from './composer';
import { type ChatDoc, DocPanel, docName } from './doc-panel';
import { AnsweredByOthers, endsWithNotice, GrillingHeader, GrillingMessage } from './grilling';
import { GRILLING_UI } from './grilling-copy';
import { Markdown } from './markdown';
import { ModelMenu } from './model-menu';

// A Conversation (ADR 0008, ticket 0046), read like Claude or Gemini: the AI's replies
// stream in under the spark, without a bubble; the person's messages sit in a tinted
// bubble; Action Cards appear under the reply that made them; the Spec or Project Brief
// opens beside the chat.
//
// The page renders what the server has; this keeps it live from the event stream
// (`conversation.*`, handed on by LiveUpdates) and from each call's answer. A refresh of
// the route (after an approval, say) brings new server data, which is merged in.

/** The text streamed so far for each reply being written, by its message id. */
type Draft = { id: string; text: string };

export type ChatProps = {
  me: { id: string; name: string };
  /** The Conversation; null on a new one, until its first message is sent. */
  initial: ConversationView | null;
  /** What it is about: the Conversation's scope, or the one picked on a new Conversation. */
  scope: ConversationScopeView | null;
  /** The Spec or Project Brief to show beside the chat. */
  doc: ChatDoc | null;
  /** Suggestions above the composer; picking one fills it in. */
  chips: string[];
  placeholder: string;
  /** Under the field: what the AI reads here, or the scope picker. */
  context: ReactNode;
  /** Shown while there is nothing in the thread (the greeting on a new Conversation). */
  empty?: (fill: (text: string) => void) => ReactNode;
  /** Why sending isn't possible yet, if it isn't. */
  sendDisabled?: string;
  /** The Approved Models for the composer's model menu; null hides it (a Grilling Conversation). */
  models: AiModelsView | null;
  /** The reader's language, for what the server wrote in a Grilling Conversation (0047). */
  lang?: Lang;
};

export function Chat({
  me,
  initial,
  scope,
  doc,
  chips,
  placeholder,
  context,
  empty,
  sendDisabled,
  models,
  lang = 'en',
}: ChatProps) {
  const router = useRouter();
  const docId = useId();
  const [messages, setMessages] = useState<ConversationMessageView[]>(initial?.messages ?? []);
  const [cards, setCards] = useState<ActionCardView[]>(initial?.actionCards ?? []);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  /** The person's message on its way, until the server's copy arrives. */
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  /** The model picked in this Conversation (the server's), and one picked since, sent with the next message. */
  const [savedModelId, setSavedModelId] = useState<string | null>(initial?.modelId ?? null);
  const [pickedModelId, setPickedModelId] = useState<string | null>(null);
  const conversationId = useRef<string | null>(initial?.id ?? null);
  /** A new Conversation is being started: its id comes with the first event. */
  const starting = useRef(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // New server data (a refresh after an approval, a reconnect): merge it in.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    if (initial) {
      setSavedModelId(initial.modelId);
      setMessages((prev) => mergeMessages(initial.messages, prev));
      setCards((prev) => mergeCards(initial.actionCards, prev));
      const lastUser = initial.messages.findLast((m) => m.role === 'USER');
      if (pending !== null && !sending && lastUser?.content === pending) setPending(null);
    }
  }

  const addMessages = useCallback((added: ConversationMessageView[]) => {
    setMessages((prev) => mergeMessages(prev, added));
    const ids = new Set(added.map((m) => m.id));
    setDrafts((prev) => prev.filter((d) => !ids.has(d.id)));
  }, []);
  const putCards = useCallback((changed: ActionCardView[]) => {
    setCards((prev) => mergeCards(prev, changed, true));
  }, []);

  // The reply as it is written, and its Action Cards, from the event stream.
  useEffect(
    () =>
      onConversationEvent((e) => {
        const id = e.data.conversationId;
        if (conversationId.current === null) {
          // The first event of the Conversation this page just started names it.
          if (!starting.current) return;
          conversationId.current = id;
        }
        if (id !== conversationId.current) return;
        switch (e.event) {
          case 'conversation.delta': {
            const { messageId, delta } = e.data;
            setDrafts((prev) =>
              prev.some((d) => d.id === messageId)
                ? prev.map((d) => (d.id === messageId ? { id: d.id, text: d.text + delta } : d))
                : [...prev, { id: messageId, text: delta }],
            );
            break;
          }
          case 'conversation.done':
            addMessages([e.data.message]);
            break;
          case 'conversation.failed': {
            const { messageId, message } = e.data;
            setDrafts((prev) => prev.filter((d) => d.id !== messageId));
            setError(message);
            break;
          }
          case 'conversation.step':
            addMessages(e.data.messages);
            break;
          case 'conversation.appended':
            addMessages(e.data.messages);
            // A Grilling moved on: the round header and the answered questions follow.
            router.refresh();
            break;
          case 'conversation.actionCard.created':
          case 'conversation.actionCard.updated':
            putCards([e.data.card]);
            break;
        }
      }),
    [addMessages, putCards, router],
  );

  const writing = drafts.length > 0;
  const busy = sending || writing;
  const last = messages.at(-1);
  const unanswered = !busy && pending === null && (last?.role === 'USER' || last?.role === 'TOOL');

  // Announce the state politely; the reply itself is announced by the log when complete.
  useEffect(() => {
    if (writing) setStatus('Vorasaan is writing a reply.');
  }, [writing]);

  // Stay at the bottom while new text arrives, unless the person scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow every change in the thread
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, drafts, pending, cards, error]);

  // Opening a Conversation shows its end, once the fonts and the layout have settled.
  useEffect(() => {
    const el = thread.current;
    if (!el) return;
    const toEnd = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    };
    const frame = requestAnimationFrame(toEnd);
    document.fonts?.ready.then(toEnd);
    return () => cancelAnimationFrame(frame);
  }, []);

  const fill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  /** A failed reply: the person's message is stored, so a refresh shows it with Retry. */
  const replyFailed = (message: string) => {
    setError(message);
    router.refresh();
  };

  // The next reply's model: the one just picked, else the Conversation's (while it is still
  // approved), else the chat default.
  const approved = (id: string | null) =>
    id !== null && (models?.models.some((m) => m.id === id) ?? false) ? id : null;
  const currentModelId =
    approved(pickedModelId) ?? approved(savedModelId) ?? models?.chatDefaultId ?? null;
  const pick = approved(pickedModelId) ? { approvedModelId: pickedModelId } : {};

  const send = async (content: string) => {
    setError(null);
    setStatus('');
    setPending(content);
    setDraft('');
    setSending(true);
    atBottom.current = true;

    if (conversationId.current === null) {
      if (!scope) {
        setSending(false);
        setPending(null);
        setDraft(content);
        return;
      }
      starting.current = true;
      const res = await postJson<ConversationView>('/api/conversations', {
        scope:
          scope.kind === 'FEATURE'
            ? { kind: 'FEATURE', featureId: scope.feature.id }
            : { kind: 'PROJECT', projectId: scope.project.id },
        content,
        ...pick,
      });
      starting.current = false;
      if (res.ok) {
        conversationId.current = res.data.id;
        setSavedModelId(res.data.modelId);
        setPickedModelId(null);
        setMessages(res.data.messages);
        setCards(res.data.actionCards);
        setDrafts([]);
        setPending(null);
        setSending(false);
        router.replace(`/conversations/${res.data.id}`);
        router.refresh();
        return;
      }
      const failed = res.body as Partial<ConversationReplyFailed> | null;
      if (res.status === 502 && failed?.conversationId) {
        setSending(false);
        setError(res.message);
        router.replace(`/conversations/${failed.conversationId}`);
        router.refresh();
        return;
      }
      conversationId.current = null;
      setSending(false);
      setPending(null);
      setDraft(content);
      setError(res.message);
      return;
    }

    const res = await postJson<ConversationTurnView>(
      `/api/conversations/${conversationId.current}/messages`,
      { content, ...pick },
    );
    setSending(false);
    if (res.ok) {
      setSavedModelId(res.data.conversation.modelId);
      setPickedModelId(null);
      addMessages([res.data.message, ...res.data.steps, res.data.reply]);
      putCards(res.data.actionCards);
      setPending(null);
      // A Grilling Conversation's header and answered questions follow the answer.
      if (res.data.conversation.grilling) router.refresh();
    } else if (res.status === 502) {
      replyFailed(res.message);
    } else {
      // Not stored (a reply still being written elsewhere, say): give the text back.
      setPending(null);
      setDraft(content);
      setError(res.message);
    }
  };

  const retry = async () => {
    const id = conversationId.current;
    if (!id) return;
    setError(null);
    setSending(true);
    atBottom.current = true;
    const res = await postJson<ConversationTurnView>(`/api/conversations/${id}/retry`);
    setSending(false);
    if (res.ok) {
      addMessages([...res.data.steps, res.data.reply]);
      putCards(res.data.actionCards);
      setPending(null);
    } else if (res.status === 502) {
      replyFailed(res.message);
    } else {
      setError(res.message);
    }
  };

  const stop = async () => {
    const id = conversationId.current;
    if (!id) return;
    setStopping(true);
    const res = await postJson(`/api/conversations/${id}/stop`);
    setStopping(false);
    // 409: it had just finished; the reply arrives as usual.
    if (res.ok) setStatus('Reply stopped.');
    input.current?.focus();
  };

  const onCardChange = (card: ActionCardView | null) => {
    if (card) putCards([card]);
    // The Spec or Brief beside the chat, the Inbox and the Sidebar may have moved on.
    router.refresh();
  };

  // ── The document panel ──────────────────────────────────────────────────────
  const narrow = useNarrow();
  const [docChoice, setDocChoice] = useState<boolean | null>(null);
  const docOpen = doc !== null && (docChoice ?? !narrow);
  const docButton = useRef<HTMLButtonElement>(null);
  const docClose = useRef<HTMLButtonElement>(null);
  const toggleDoc = (open: boolean) => {
    setDocChoice(open);
    requestAnimationFrame(() => (open ? docClose.current : docButton.current)?.focus());
  };
  const proposalKind = doc?.kind === 'SPEC' ? 'SPEC_PROPOSAL' : 'BRIEF_PROPOSAL';
  const pendingProposal =
    cards.findLast((c) => c.kind === proposalKind && c.status === 'PROPOSED' && c.detail) ?? null;

  // ── Rendering ───────────────────────────────────────────────────────────────
  const cardsByMessage = new Map<string, ActionCardView[]>();
  for (const card of cards) {
    cardsByMessage.set(card.messageId, [...(cardsByMessage.get(card.messageId) ?? []), card]);
  }
  const visible = messages.filter((m) => m.role !== 'TOOL');
  const nothingYet = visible.length === 0 && pending === null && drafts.length === 0;
  const grilling = initial?.grilling ?? null;
  const progress = initial?.grillingProgress ?? null;
  const asking = progress?.questions.some((q) => q.status === 'ASKING') ?? false;
  const g = GRILLING_UI[lang];

  return (
    <div className="chat" data-doc={docChoice === null ? 'auto' : docOpen ? 'open' : 'closed'}>
      <div className="chat-main">
        <header className="chat-top">
          <nav className="crumbs" aria-label="Where this Conversation belongs">
            {scope ? (
              <>
                <Link href={`/projects/${scope.project.id}`}>{scope.project.name}</Link>
                {scope.kind === 'FEATURE' && (
                  <>
                    <span aria-hidden> › </span>
                    <Link href={`/features/${scope.feature.id}`}>
                      <b>{scope.feature.title}</b>
                    </Link>
                  </>
                )}
                {grilling && (
                  <>
                    <span aria-hidden> › </span>
                    <b lang={lang}>{g.crumb(g.round[grilling.round])}</b>
                  </>
                )}
              </>
            ) : (
              <b>New conversation</b>
            )}
          </nav>
          <span className="flex-1" />
          {doc && (
            <button
              ref={docButton}
              type="button"
              className="chip"
              aria-pressed={docOpen}
              aria-controls={docId}
              title={docOpen ? `Close the ${docName(doc)}` : `Open the ${docName(doc)}`}
              onClick={() => toggleDoc(!docOpen)}
            >
              <DocIcon />
              {doc.kind === 'SPEC' ? 'Spec' : 'Brief'}
              {doc.version > 0 ? ` v${doc.version}` : ''}
            </button>
          )}
        </header>

        <div
          ref={thread}
          className="chat-thread"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {progress && <GrillingHeader progress={progress} lang={lang} />}
          {nothingYet && empty ? (
            empty(fill)
          ) : (
            <div
              className="chat-col"
              role="log"
              aria-label="Messages"
              aria-live="polite"
              aria-relevant="additions text"
              aria-busy={writing}
            >
              {visible.map((m, i) => {
                const prev = visible[i - 1];
                const startsTurn =
                  i === 0 || prev?.role !== 'ASSISTANT' || (prev ? endsWithNotice(prev) : false);
                return (
                  <Fragment key={m.id}>
                    {m.role === 'USER' ? (
                      <UserMessage content={m.content} />
                    ) : m.grillingNotes ? (
                      <GrillingMessage notes={m.grillingNotes} first={startsTurn} lang={lang} />
                    ) : (
                      <AiMessage message={m} first={startsTurn} grilling={grilling !== null} />
                    )}
                    {i === 0 && progress && (
                      <AnsweredByOthers questions={progress.questions} meId={me.id} lang={lang} />
                    )}
                    {(cardsByMessage.get(m.id) ?? []).map((card) => (
                      <ActionCard key={card.id} card={card} meId={me.id} onChange={onCardChange} />
                    ))}
                  </Fragment>
                );
              })}
              {pending !== null && <UserMessage content={pending} />}
              {drafts.map((d, i) => (
                <AiMessage
                  key={d.id}
                  first={i === 0 && visible.at(-1)?.role !== 'ASSISTANT'}
                  grilling={grilling !== null}
                  message={{ content: d.text, toolCalls: null }}
                  streaming
                />
              ))}
              {sending && drafts.length === 0 && (
                <div className="msg ai thinking">
                  <Spark size={28} className="spark" />
                  <span className="who">Vorasaan is thinking…</span>
                </div>
              )}
              {(error || unanswered) && !busy && (
                <div className="chat-error" role={error ? 'alert' : undefined}>
                  <p>{error ?? 'This message has no reply yet.'}</p>
                  {(unanswered || pending !== null) && conversationId.current && (
                    <button type="button" className="btn" onClick={retry}>
                      Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {(chips.length > 0 || asking) && !busy && (
            <div className="suggest">
              {asking && (
                // Sends the skip word: the server skips the question being asked (0044).
                <button
                  type="button"
                  className="chip skip-chip"
                  lang={lang}
                  onClick={() => send(g.skipWord)}
                >
                  {g.skip}
                </button>
              )}
              {chips.map((c) => (
                <button key={c} type="button" className="chip" onClick={() => fill(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            replying={busy}
            onStop={stop}
            stopping={stopping || (sending && conversationId.current === null && !writing)}
            placeholder={placeholder}
            attachTo={attachOwner(scope)}
            context={context}
            model={
              models && (
                <ModelMenu
                  models={models.models}
                  currentId={currentModelId}
                  onPick={setPickedModelId}
                />
              )
            }
            disabled={sendDisabled}
            inputRef={input}
          />
          <p className="disclaimer">
            The AI only proposes. Nothing changes until a person approves it.
          </p>
          <p role="status" className="sr-only">
            {status}
          </p>
        </div>
      </div>

      {doc && docOpen && (
        <DocPanel
          id={docId}
          doc={doc}
          pending={pendingProposal}
          onClose={() => toggleDoc(false)}
          closeRef={docClose}
        />
      )}
    </div>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="msg user">
      <span className="sr-only">You: </span>
      <div className="bubble">{content}</div>
    </div>
  );
}

function AiMessage({
  message,
  first,
  grilling,
  streaming = false,
}: {
  message: Pick<ConversationMessageView, 'content' | 'toolCalls'> &
    Partial<Pick<ConversationMessageView, 'model' | 'modelNotice'>>;
  /** The first of the AI's messages in a turn carries the spark. */
  first: boolean;
  grilling: boolean;
  streaming?: boolean;
}) {
  const calls = message.toolCalls ?? [];
  const stoppedEmpty = !streaming && !message.content && calls.length === 0;
  // The reply (not a step that called tools) names the model that wrote it.
  const model = !streaming && calls.length === 0 ? (message.model ?? null) : null;
  return (
    <div className={first ? 'msg ai' : 'msg ai cont'}>
      {first && (
        <>
          <Spark size={28} className="spark" />
          <div className="who">{grilling ? 'Vorasaan · Grilling' : 'Vorasaan'}</div>
        </>
      )}
      {!first && <span className="sr-only">Vorasaan: </span>}
      {message.modelNotice && <p className="model-notice">{message.modelNotice}</p>}
      {message.content && <Markdown>{message.content}</Markdown>}
      {stoppedEmpty && <p className="stopped">Stopped before replying.</p>}
      {streaming && <span className="caret-blink" aria-hidden />}
      {calls.map((c) => (
        <div key={c.id} className="tool">
          {toolText(c.name, c.args)}
        </div>
      ))}
      {model && (
        <div className="by">
          <span className="sr-only">Written with </span>
          {model.displayName ?? model.modelId}
        </div>
      )}
    </div>
  );
}

function toolText(name: string, args: unknown): string {
  switch (name) {
    case 'searchContext': {
      const query = (args as { query?: unknown } | null)?.query;
      return typeof query === 'string'
        ? `Searched the context for “${query}”`
        : 'Searched the context';
    }
    case 'draftDecisionRequest':
      return 'Drafted a Decision Request';
    case 'draftSpecProposal':
      return 'Drafted a Spec Proposal';
    case 'draftBriefProposal':
      return 'Drafted a Brief Proposal';
    case 'suggestFeatures':
      return 'Suggested Features';
    default:
      return name;
  }
}

function attachOwner(scope: ConversationScopeView | null): AttachmentOwner | null {
  if (!scope) return null;
  return scope.kind === 'FEATURE'
    ? { kind: 'features', id: scope.feature.id }
    : { kind: 'projects', id: scope.project.id };
}

/** `base` with `added` merged in by id; an added message replaces the same id. Oldest first. */
function mergeMessages(
  base: ConversationMessageView[],
  added: ConversationMessageView[],
): ConversationMessageView[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const m of added) byId.set(m.id, m);
  // Stable: messages written in the same millisecond keep their order.
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * `base` with `changed` merged in by id. A card that was reviewed (approved, declined,
 * stale) wins over an older PROPOSED copy, whichever side it is on; `preferChanged`
 * otherwise takes the incoming copy.
 */
function mergeCards(
  base: ActionCardView[],
  changed: ActionCardView[],
  preferChanged = false,
): ActionCardView[] {
  const byId = new Map(base.map((c) => [c.id, c]));
  for (const c of changed) {
    const old = byId.get(c.id);
    if (!old) byId.set(c.id, c);
    else if (old.status === 'PROPOSED' && c.status !== 'PROPOSED') byId.set(c.id, c);
    else if (old.status !== 'PROPOSED' && c.status === 'PROPOSED') continue;
    else if (preferChanged || c.status !== 'PROPOSED') byId.set(c.id, c);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Narrow screens show the document as an overlay, closed until asked for. */
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1180px)');
    setNarrow(query.matches);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
