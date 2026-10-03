'use client';

import type {
  ActionCardView,
  AiModelsView,
  CompactConversationResult,
  ConversationCompactionView,
  ConversationMessagePage,
  ConversationMessageView,
  ConversationReplyFailed,
  ConversationScopeView,
  ConversationTurnView,
  ConversationUsage,
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
import { getJson, postJson } from '@/lib/chat-client';
import { onConversationEvent } from '@/lib/conversation-events';
import type { AttachmentOwner } from '@/lib/ids';
import type { Lang } from '@/lib/lang';
import { DocIcon, Flame } from '../icons';
import { Button } from '../ui/button';
import { SkeletonText } from '../ui/skeleton';
import { toast } from '../ui/toast';
import { ActionCard } from './action-card';
import { CompactionDivider } from './compaction-divider';
import { Composer } from './composer';
import { ContextMeter } from './context-meter';
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

//
// Long Conversations load like a chat app (ticket 0066): the latest page first, scrolled
// to the bottom; older pages as the person scrolls up, keeping their place; and, from a
// deep link (`?message=`), the page around a message with pages both ways. A compaction
// shows as a thin divider; the messages above it stay as they are.

/** The text streamed so far for each reply being written, by its message id. */
type Draft = { id: string; text: string };

/** Load the next page when the view is this close (px) to the end it pages from. */
const PAGE_MARGIN = 400;

/** `/compact` and what to keep, as typed in the composer. */
const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*))?$/i;

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
  /** A deep link's message (`?message=`): shown in the middle, highlighted. */
  focusMessageId?: string | null;
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
  focusMessageId = null,
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
  /** Where the loaded messages sit (ticket 0066): a cursor each way while there is more. */
  const [olderCursor, setOlderCursor] = useState(initial?.page.olderCursor ?? null);
  const [newerCursor, setNewerCursor] = useState(initial?.page.newerCursor ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Every compaction: a divider above the first message the AI still reads word for word. */
  const [compactions, setCompactions] = useState<ConversationCompactionView[]>(
    initial?.compactions ?? [],
  );
  /** The context meter's numbers, for the model the next reply runs on. */
  const [usage, setUsage] = useState<ConversationUsage | null>(null);
  const [compacting, setCompacting] = useState(false);
  /** A compaction waits for the Action Card that records agreed points (or a skip). */
  const [waiting, setWaiting] = useState<{ focus: string | null; cardId: string } | null>(null);
  /** New messages arrived while the person read further up. */
  const [newPill, setNewPill] = useState(false);
  const conversationId = useRef<string | null>(initial?.id ?? null);
  /** A new Conversation is being started: its id comes with the first event. */
  const starting = useRef(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const atBottom = useRef(!focusMessageId);
  /** Where the view was before content went in above it, to put it back (no jump). */
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const paging = useRef(false);
  /** Whether the loaded messages reach the latest one: live messages are added only then. */
  const atLatest = useRef(newerCursor === null);
  atLatest.current = newerCursor === null;
  /** The newest loaded message's position, and whether this page is sending (its own turn). */
  const lastPosition = useRef(-1);
  lastPosition.current = messages.at(-1)?.position ?? -1;
  const sendingNow = useRef(false);
  sendingNow.current = sending;

  // New server data (a refresh after an approval, a reconnect): merge it in.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    if (initial) {
      setSavedModelId(initial.modelId);
      setCompactions((prev) => mergeById(prev, initial.compactions));
      setMessages((prev) => mergeMessages(initial.messages, prev));
      setCards((prev) => mergeCards(initial.actionCards, prev));
      const lastUser = initial.messages.findLast((m) => m.role === 'USER');
      if (pending !== null && !sending && lastUser?.content === pending) setPending(null);
    }
  }

  const keepPlace = () => {
    const el = thread.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
  };

  /** Messages that arrived live: added when the latest page is loaded; a pill when read further up. */
  const arrived = useCallback((added: ConversationMessageView[]) => {
    if (!atBottom.current) setNewPill(true);
    if (!atLatest.current) return;
    // Something was written between (a message sent from another tab): fetch the latest
    // page too, so the thread has no hole.
    const first = added.reduce((min, m) => Math.min(min, m.position), Number.POSITIVE_INFINITY);
    if (first > lastPosition.current + 1 && !sendingNow.current && conversationId.current) {
      void getJson<ConversationMessagePage>(
        `/api/conversations/${conversationId.current}/messages`,
      ).then((res) => {
        if (res.ok) setMessages((prev) => mergeMessages(prev, res.data.messages));
      });
    }
    setMessages((prev) => mergeMessages(prev, added));
    const ids = new Set(added.map((m) => m.id));
    setDrafts((prev) => prev.filter((d) => !ids.has(d.id)));
  }, []);
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
            if (!atLatest.current) {
              if (!atBottom.current) setNewPill(true);
              break;
            }
            setDrafts((prev) =>
              prev.some((d) => d.id === messageId)
                ? prev.map((d) => (d.id === messageId ? { id: d.id, text: d.text + delta } : d))
                : [...prev, { id: messageId, text: delta }],
            );
            break;
          }
          case 'conversation.done':
            arrived([e.data.message]);
            break;
          case 'conversation.usage':
            // The meter follows the Conversation's own model; a model being tried keeps its own.
            setUsage((prev) =>
              !prev || prev.model.approvedModelId === e.data.usage.model.approvedModelId
                ? e.data.usage
                : prev,
            );
            break;
          case 'conversation.compacted':
            setCompactions((prev) => mergeById(prev, [e.data.compaction]));
            break;
          case 'conversation.failed': {
            const { messageId, message } = e.data;
            setDrafts((prev) => prev.filter((d) => d.id !== messageId));
            setError(message);
            break;
          }
          case 'conversation.step':
            arrived(e.data.messages);
            break;
          case 'conversation.appended':
            arrived(e.data.messages);
            // A Grilling moved on: the round header and the answered questions follow.
            router.refresh();
            break;
          case 'conversation.actionCard.created':
          case 'conversation.actionCard.updated':
            putCards([e.data.card]);
            break;
        }
      }),
    [arrived, putCards, router],
  );

  const writing = drafts.length > 0;
  const busy = sending || writing;
  const last = messages.at(-1);
  const unanswered =
    !busy &&
    pending === null &&
    newerCursor === null &&
    (last?.role === 'USER' || last?.role === 'TOOL');

  // Announce the state politely; the reply itself is announced by the log when complete.
  useEffect(() => {
    if (writing) setStatus('Vorasaan is writing a reply.');
  }, [writing]);

  // Content went in above the view (an older page, its skeleton): put the view back where
  // it was, so what the person reads doesn't move. Else stay at the bottom while new text
  // arrives, unless the person scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow every change in the thread
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el) return;
    const kept = anchor.current;
    if (kept) {
      anchor.current = null;
      el.scrollTop = kept.top + (el.scrollHeight - kept.height);
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, drafts, pending, cards, error, loadingOlder, compactions]);

  // Opening a Conversation shows its end (or a deep link's message), once the fonts and
  // the layout have settled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on opening
  useEffect(() => {
    const el = thread.current;
    if (!el) return;
    const place = () => {
      if (focusMessageId) {
        el.querySelector(`[data-message-id="${focusMessageId}"]`)?.scrollIntoView({
          block: 'center',
        });
      } else if (atBottom.current) {
        el.scrollTop = el.scrollHeight;
      }
    };
    const frame = requestAnimationFrame(place);
    document.fonts?.ready.then(place);
    return () => cancelAnimationFrame(frame);
  }, []);

  // ── Pages (ticket 0066) ─────────────────────────────────────────────────────
  const id = conversationId.current;
  const loadOlder = async () => {
    if (!id || !olderCursor || paging.current) return;
    paging.current = true;
    keepPlace();
    setLoadingOlder(true);
    const res = await getJson<ConversationMessagePage>(
      `/api/conversations/${id}/messages?before=${olderCursor}`,
    );
    keepPlace();
    setLoadingOlder(false);
    if (res.ok) {
      setMessages((prev) => mergeMessages(res.data.messages, prev));
      setOlderCursor(res.data.olderCursor);
    } else {
      toast({ title: 'Could not load earlier messages', description: res.message, tone: 'error' });
    }
    paging.current = false;
  };
  const loadNewer = async () => {
    if (!id || !newerCursor || paging.current) return;
    paging.current = true;
    const res = await getJson<ConversationMessagePage>(
      `/api/conversations/${id}/messages?after=${newerCursor}`,
    );
    if (res.ok) {
      setMessages((prev) => mergeMessages(prev, res.data.messages));
      setNewerCursor(res.data.newerCursor);
    }
    paging.current = false;
  };
  /** The latest page, in place of what is loaded (from a deep link, before sending). */
  const loadLatest = async () => {
    if (!id) return;
    const res = await getJson<ConversationMessagePage>(`/api/conversations/${id}/messages`);
    if (!res.ok) return;
    atBottom.current = true;
    setMessages(res.data.messages);
    setOlderCursor(res.data.olderCursor);
    setNewerCursor(null);
    setDrafts([]);
  };
  const toLatest = async () => {
    setNewPill(false);
    atBottom.current = true;
    if (newerCursor) await loadLatest();
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // A first page shorter than the view can't be scrolled up: load the next one now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: after each page
  useEffect(() => {
    const el = thread.current;
    if (el && olderCursor && el.scrollHeight <= el.clientHeight + PAGE_MARGIN) void loadOlder();
  }, [olderCursor]);

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

  // ── The context meter (ticket 0066) ───────────────────────────────────────
  // Loaded on opening, and again for a model picked in the menu (the server's numbers for
  // that model's window). After that, each turn and compaction brings fresh numbers.
  useEffect(() => {
    if (!id || !models) return;
    let live = true;
    const query = currentModelId ? `?approvedModelId=${currentModelId}` : '';
    getJson<ConversationUsage>(`/api/conversations/${id}/usage${query}`).then((res) => {
      if (live && res.ok) setUsage(res.data);
    });
    return () => {
      live = false;
    };
  }, [id, models, currentModelId]);

  // ── Compacting (ticket 0066) ─────────────────────────────────────────────
  const compact = async (focus: string | null, skipRecordCheck = false) => {
    if (!id) return;
    setError(null);
    setCompacting(true);
    setStatus('Compacting the Conversation.');
    const res = await postJson<CompactConversationResult>(`/api/conversations/${id}/compact`, {
      ...(focus ? { focus } : {}),
      ...(skipRecordCheck ? { skipRecordCheck: true } : {}),
    });
    setCompacting(false);
    if (!res.ok) {
      setStatus('');
      toast({ title: 'Could not compact', description: res.message, tone: 'error' });
      return;
    }
    if (res.data.status === 'RECORD_FIRST') {
      // The AI offers to record agreed points first; compaction waits for the card.
      atBottom.current = true;
      addMessages(res.data.messages);
      putCards([res.data.card]);
      setWaiting({ focus, cardId: res.data.card.id });
      setStatus('Before compacting, the AI offers to record what was agreed.');
      return;
    }
    const { compaction, usage: after } = res.data;
    setWaiting(null);
    setCompactions((prev) => mergeById(prev, [compaction]));
    setUsage(after);
    setStatus('Compacted.');
    toast({
      title: 'Compacted',
      description: `The AI now reads the ${compaction.summarizedThrough} earlier messages as a summary. They stay here to read.`,
      tone: 'success',
    });
  };

  const send = async (content: string) => {
    const command = COMPACT_COMMAND.exec(content.trim());
    if (command) {
      if (!conversationId.current) {
        setError('Start the Conversation first: there is nothing to compact yet.');
        return;
      }
      setDraft('');
      await compact(command[1]?.trim() || null);
      return;
    }
    setError(null);
    setStatus('');
    setPending(content);
    setDraft('');
    setSending(true);
    atBottom.current = true;
    setNewPill(false);
    // From a deep link: the reply goes at the end, so show the end first.
    if (newerCursor) await loadLatest();

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
        setOlderCursor(res.data.page.olderCursor);
        setCompactions(res.data.compactions);
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
      if (res.data.usage) setUsage(res.data.usage);
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
      if (res.data.usage) setUsage(res.data.usage);
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
    // The card a compaction waited for was approved or declined: compaction goes on.
    if (card && waiting?.cardId === card.id && card.status !== 'PROPOSED') {
      const { focus } = waiting;
      setWaiting(null);
      void compact(focus, true);
    }
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
  const dividers = new Map<string, ConversationCompactionView[]>();
  for (const c of compactions) {
    if (c.beforeMessageId)
      dividers.set(c.beforeMessageId, [...(dividers.get(c.beforeMessageId) ?? []), c]);
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

        <div className="thread-wrap">
          <div
            ref={thread}
            className="chat-thread"
            onScroll={(e) => {
              const el = e.currentTarget;
              const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              atBottom.current = fromBottom < 80;
              if (atBottom.current && newerCursor === null) setNewPill(false);
              if (el.scrollTop < PAGE_MARGIN && olderCursor) void loadOlder();
              if (fromBottom < PAGE_MARGIN && newerCursor) void loadNewer();
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
                aria-busy={writing || loadingOlder}
              >
                {olderCursor && (
                  <div className="older-loading" aria-busy={loadingOlder}>
                    {loadingOlder ? (
                      <>
                        <span role="status" className="sr-only">
                          Loading earlier messages
                        </span>
                        <SkeletonText lines={2} />
                        <SkeletonText lines={3} />
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="justify-self-center"
                        onPress={loadOlder}
                      >
                        Load earlier messages
                      </Button>
                    )}
                  </div>
                )}
                {visible.map((m, i) => {
                  const prev = visible[i - 1];
                  const startsTurn =
                    i === 0 || prev?.role !== 'ASSISTANT' || (prev ? endsWithNotice(prev) : false);
                  return (
                    <Fragment key={m.id}>
                      {id &&
                        (dividers.get(m.id) ?? []).map((c) => (
                          <CompactionDivider key={c.id} conversationId={id} compaction={c} />
                        ))}
                      {m.role === 'USER' ? (
                        <UserMessage
                          id={m.id}
                          content={m.content}
                          focused={m.id === focusMessageId}
                        />
                      ) : m.grillingNotes ? (
                        <GrillingMessage notes={m.grillingNotes} first={startsTurn} lang={lang} />
                      ) : (
                        <AiMessage
                          message={m}
                          first={startsTurn}
                          grilling={grilling !== null}
                          focused={m.id === focusMessageId}
                        />
                      )}
                      {i === 0 && olderCursor === null && progress && (
                        <AnsweredByOthers questions={progress.questions} meId={me.id} lang={lang} />
                      )}
                      {(cardsByMessage.get(m.id) ?? []).map((card) => (
                        <ActionCard
                          key={card.id}
                          card={card}
                          meId={me.id}
                          onChange={onCardChange}
                        />
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
                    <Flame size={26} className="spark" />
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
                {compacting && (
                  <div className="msg ai thinking">
                    <Flame size={26} className="spark" />
                    <span className="who">Compacting the Conversation…</span>
                  </div>
                )}
              </div>
            )}
          </div>
          {newPill && (
            <button type="button" className="new-pill" onClick={toLatest}>
              ↓ New messages
            </button>
          )}
        </div>

        <div className="composer-wrap">
          {waiting && (
            <div className="compact-wait">
              <span>
                Compaction waits for the Action Card above: approve or decline it, or skip it.
              </span>
              <Button
                size="sm"
                isDisabled={compacting}
                onPress={() => {
                  const { focus } = waiting;
                  setWaiting(null);
                  void compact(focus, true);
                }}
              >
                Skip and compact
              </Button>
              <Button size="sm" variant="ghost" onPress={() => setWaiting(null)}>
                Cancel
              </Button>
            </div>
          )}
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
                <>
                  <ModelMenu
                    models={models.models}
                    currentId={currentModelId}
                    onPick={setPickedModelId}
                  />
                  <ContextMeter
                    usage={usage}
                    onCompact={() => compact(null)}
                    compacting={compacting}
                    canCompact={!busy && !compacting}
                  />
                </>
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

function UserMessage({
  id,
  content,
  focused = false,
}: {
  id?: string;
  content: string;
  /** A deep link's message: highlighted. */
  focused?: boolean;
}) {
  return (
    <div className={focused ? 'msg user focused' : 'msg user'} data-message-id={id}>
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
  focused = false,
}: {
  message: Pick<ConversationMessageView, 'content' | 'toolCalls'> &
    Partial<Pick<ConversationMessageView, 'id' | 'model' | 'modelNotice'>>;
  /** The first of the AI's messages in a turn carries the spark. */
  first: boolean;
  grilling: boolean;
  streaming?: boolean;
  /** A deep link's message: highlighted. */
  focused?: boolean;
}) {
  const calls = message.toolCalls ?? [];
  const stoppedEmpty = !streaming && !message.content && calls.length === 0;
  // The reply (not a step that called tools) names the model that wrote it.
  const model = !streaming && calls.length === 0 ? (message.model ?? null) : null;
  return (
    <div
      className={`${first ? 'msg ai' : 'msg ai cont'}${focused ? ' focused' : ''}`}
      data-message-id={message.id}
    >
      {first && (
        <>
          <Flame size={26} className="spark" />
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
  // In the order written: positions are unique per Conversation, whatever the timestamps.
  return [...byId.values()].sort((a, b) => a.position - b.position);
}

/** `base` with `added` merged in by id, in `number` order (compactions). */
function mergeById<T extends { id: string; number: number }>(base: T[], added: T[]): T[] {
  const byId = new Map(base.map((c) => [c.id, c]));
  for (const c of added) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.number - b.number);
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
