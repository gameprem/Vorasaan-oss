import type {
  DecisionRequestView,
  FeatureSummaryView,
  InboxItem,
  NotificationList,
  ServerEvent,
  SpecVersionView,
} from '@vorasaan/shared';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { VorasaanApi } from '../api.ts';
import type { RepoScope } from '../commands/raise-flow.ts';
import type { LiveStatus } from '../events.ts';
import type { Notifier } from '../notify.ts';
import { ListView, type Row, ScrollText } from './components.tsx';
import {
  errorMessage,
  inboxItemDetail,
  inboxItemKey,
  inboxItemLine,
  inboxItemRequestId,
  notificationLine,
  requestLine,
} from './format.ts';
import { type ProposalKind, ProposalScreen } from './ProposalScreen.tsx';
import { RaiseForm } from './RaiseForm.tsx';
import { RequestScreen } from './RequestScreen.tsx';
import { type Remote, RemoteStatus, useRemote } from './remote.tsx';

/** What the TUI needs from the server; tests pass a fake. */
export type TuiApi = Pick<
  VorasaanApi,
  | 'me'
  | 'inbox'
  | 'notifications'
  | 'myRequests'
  | 'listFeatures'
  | 'feature'
  | 'team'
  | 'myTeams'
  | 'specVersions'
  | 'decisionRequest'
  | 'raise'
  | 'submit'
  | 'withdraw'
  | 'claim'
  | 'reassign'
  | 'postMessage'
  | 'decide'
  | 'specProposal'
  | 'approveSpecProposal'
  | 'rejectSpecProposal'
  | 'briefProposal'
  | 'approveBriefProposal'
  | 'rejectBriefProposal'
  | 'markNotificationRead'
  | 'markAllNotificationsRead'
>;

export type TuiRepo = RepoScope & { notice?: string };

/** Starts the live event stream; returns a function that stops it. Tests pass a fake. */
export type LiveFeed = (handlers: {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: LiveStatus) => void;
}) => () => void;

type InboxData = { items: InboxItem[]; notifications: NotificationList };

const TABS = ['Inbox', 'My Requests', 'Features'] as const;
type Tab = 0 | 1 | 2;

type View =
  | { kind: 'list' }
  | { kind: 'request'; id: string; actHint?: boolean }
  | { kind: 'proposal'; proposal: ProposalKind; id: string; title?: string }
  | { kind: 'spec'; feature: { id: string; title: string } }
  | { kind: 'text'; title: string; lines: string[] }
  | { kind: 'raise' };

export const HELP_LINE =
  'Tab/1-3 switch · ↑↓/j/k move · Enter open · Esc back · r raise · R refresh · ? help · q quit';

const FULL_HELP = [
  'Tab / Shift-Tab or 1 2 3  switch tabs (refreshes the tab)',
  '↑ ↓ or j k                move; in a Spec, request or diff: scroll (space/b page, g/G ends)',
  'Enter                     open the selected item · Esc  back to the list',
  'r                         raise a Blocker or Question with context from this repository',
  'R                         refresh · a  (Features) all Projects / only the bound Project',
  'm / M                     (Inbox) mark the Notification read / all Notifications read',
  'In a request              d decide · c Claim · i ask for info · s reassign · a answer',
  '                          n note · w withdraw · p open its Spec Proposal',
  'In a proposal             a approve · x reject (asks first)',
  'q or Ctrl-C               quit',
];

/** Live events arrive in bursts (one action touches several people): refresh once. */
const LIVE_DEBOUNCE_MS = 300;
/** More new Inbox Items than this at once become a single OS notification. */
const MAX_NOTIFICATIONS = 3;

/** The latest Spec Version of a Feature, scrollable. */
export function SpecScreen({
  api,
  feature,
  height,
}: {
  api: TuiApi;
  feature: { id: string; title: string };
  height: number;
}) {
  const state = useRemote<SpecVersionView[]>(() => api.specVersions(feature.id), feature.id);
  if (state.status !== 'ok') return <RemoteStatus state={state} />;
  const latest = state.data.reduce<SpecVersionView | undefined>(
    (best, v) => (!best || v.version > best.version ? v : best),
    undefined,
  );
  if (!latest) {
    return (
      <Box flexDirection="column">
        <Text bold>{feature.title}</Text>
        <Text dimColor>No Spec Version yet.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>
        {feature.title} · Spec v{latest.version}
        <Text dimColor>
          {' '}
          approved by {latest.approvedBy.name}
          {latest.summary ? ` · ${latest.summary}` : ''}
        </Text>
      </Text>
      <ScrollText lines={latest.markdown.split('\n')} height={height} />
    </Box>
  );
}

function LiveIndicator({ status }: { status: LiveStatus | undefined }) {
  if (!status) return null;
  switch (status.state) {
    case 'connecting':
      return <Text dimColor> ◌ connecting…</Text>;
    case 'live':
      return <Text color="green"> ● live</Text>;
    case 'offline':
      return (
        <Text color="yellow">
          {' '}
          ○ offline · retrying in {Math.max(1, Math.round(status.retryInMs / 1000))}s
        </Text>
      );
    case 'stopped':
      return <Text color="red"> ✖ live updates off</Text>;
  }
}

export function App({
  api,
  repo,
  height: fixedHeight,
  live,
  notifier,
}: {
  api: TuiApi;
  repo: TuiRepo;
  /** Rows for lists and text; defaults to the terminal height. */
  height?: number;
  /** Live updates over `GET /events`; without it the TUI refreshes on keys only. */
  live?: LiveFeed;
  /** OS notifications for new Inbox Items and Notifications. */
  notifier?: Pick<Notifier, 'notify' | 'disabledReason'>;
}) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const height = fixedHeight ?? Math.max(5, (rows || 24) - 8);

  const [tab, setTab] = useState<Tab>(0);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [selected, setSelected] = useState<[number, number, number]>([0, 0, 0]);
  const [help, setHelp] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [inbox, setInbox] = useState<Remote<InboxData>>({ status: 'loading' });
  const [requests, setRequests] = useState<Remote<DecisionRequestView[]>>({ status: 'loading' });
  const [features, setFeatures] = useState<Remote<FeatureSummaryView[]>>({ status: 'loading' });
  const [meId, setMeId] = useState<string>();
  const [liveStatus, setLiveStatus] = useState<LiveStatus>();
  /** Bumped by live events and actions: open screens reload quietly. */
  const [tick, setTick] = useState(0);
  /** A form inside a screen has the keyboard: global keys (q, r, Tab…) are off. */
  const [capture, setCapture] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string }>();

  // Inbox Items seen so far; undefined until the first load, which never notifies.
  const seenItems = useRef<Set<string> | undefined>(undefined);
  const notifierRef = useRef(notifier);
  notifierRef.current = notifier;

  // Every load settles into state; a failed request becomes a message, never a crash.
  // A quiet load (live refresh) keeps the list on screen until the new one arrives.
  const load = useCallback(
    (which: Tab, quiet = false) => {
      const settle = <T,>(
        set: (update: (r: Remote<T>) => Remote<T>) => void,
        promise: Promise<T>,
      ) => {
        if (!quiet) set(() => ({ status: 'loading' }));
        promise.then(
          (data) => set(() => ({ status: 'ok', data })),
          (error) =>
            set((r) =>
              quiet && r.status === 'ok' ? r : { status: 'error', message: errorMessage(error) },
            ),
        );
      };
      if (which === 0) {
        settle(
          setInbox,
          Promise.all([api.inbox(), api.notifications()]).then(([items, notifications]) => {
            const seen = seenItems.current;
            const fresh = seen ? items.filter((item) => !seen.has(inboxItemKey(item))) : [];
            // A burst (e.g. back online after a while) becomes one notification, not a flood.
            if (fresh.length > MAX_NOTIFICATIONS) {
              notifierRef.current?.notify('Vorasaan: needs you', `${fresh.length} new Inbox Items`);
            } else {
              for (const item of fresh) {
                notifierRef.current?.notify('Vorasaan: needs you', inboxItemLine(item));
              }
            }
            seenItems.current = new Set(items.map(inboxItemKey));
            return { items, notifications };
          }),
        );
      } else if (which === 1) settle(setRequests, api.myRequests());
      else settle(setFeatures, api.listFeatures());
    },
    [api],
  );

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  useEffect(() => {
    api.me().then(
      (me) => setMeId(me.id),
      () => {},
    );
  }, [api]);

  // Something changed on the server or here: refresh the Inbox (it drives the OS
  // notifications), the tab on screen and any open request or proposal, quietly.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const refreshAll = useCallback(() => {
    load(0, true);
    if (tabRef.current !== 0) load(tabRef.current, true);
    setTick((t) => t + 1);
  }, [load]);

  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasLive = false;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(refreshAll, LIVE_DEBOUNCE_MS);
    };
    const stop = live({
      onEvent: (event) => {
        if (event.event === 'notification.created') {
          // Without the unread marker: the OS shows one plain line.
          const line = notificationLine(event.data.notification).replace(/^[•\s]+/, '');
          notifierRef.current?.notify('Vorasaan', line);
        }
        later();
      },
      onStatus: (status) => {
        setLiveStatus(status);
        // Events may have been missed while offline: catch up on reconnect.
        if (status.state === 'live') {
          if (wasLive) later();
          wasLive = true;
        }
      },
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [live, refreshAll]);

  const onCapture = useCallback((on: boolean) => setCapture(on), []);

  const bound = repo.projectId;
  const featureList =
    features.status === 'ok'
      ? features.data.filter((f) => !bound || showAll || f.projectId === bound)
      : [];
  const boundName =
    features.status === 'ok' ? features.data.find((f) => f.projectId === bound)?.projectName : '';

  const inboxRows: Row[] =
    inbox.status === 'ok'
      ? [
          ...inbox.data.items.map((item, i) => ({
            key: `item-${i}`,
            label: inboxItemLine(item),
            header: i === 0 ? `Inbox Items (${inbox.data.items.length})` : undefined,
          })),
          ...inbox.data.notifications.notifications.map((n, i) => ({
            key: n.id,
            label: notificationLine(n),
            header:
              i === 0
                ? `Notifications (${inbox.data.notifications.unreadCount} unread)`
                : undefined,
          })),
        ]
      : [];
  const requestRows: Row[] =
    requests.status === 'ok'
      ? requests.data.map((r) => ({ key: r.id, label: requestLine(r) }))
      : [];
  const featureRows: Row[] = featureList.map((f) => ({
    key: f.id,
    label: `${f.projectId === bound ? '● ' : ''}${f.title}  ${f.projectName} / ${f.teamName} · ${f.myRoles.join(', ')}`,
    highlight: Boolean(bound) && f.projectId === bound,
  }));
  const rowsOf = [inboxRows, requestRows, featureRows] as const;
  const current = Math.min(selected[tab], Math.max(0, rowsOf[tab].length - 1));

  const switchTab = (next: Tab) => {
    setView({ kind: 'list' });
    if (next === tab) load(tab);
    else setTab(next);
  };

  const open = () => {
    if (tab === 0 && inbox.status === 'ok') {
      const { items } = inbox.data;
      if (current < items.length) {
        const item = items[current];
        if (!item) return;
        if (item.kind === 'APPROVE_PROPOSAL') {
          setView({
            kind: 'proposal',
            proposal: 'spec',
            id: item.specProposal.id,
            title: item.feature.title,
          });
          return;
        }
        if (item.kind === 'APPROVE_BRIEF_PROPOSAL') {
          setView({
            kind: 'proposal',
            proposal: 'brief',
            id: item.briefProposal.id,
            title: item.project.name,
          });
          return;
        }
        const requestId = inboxItemRequestId(item);
        setView(
          requestId
            ? {
                kind: 'request',
                id: requestId,
                // A Delegate decides for someone else: the request names them, not me.
                actHint: item.kind === 'DECIDE' && item.decisionRequest.onBehalfOf !== null,
              }
            : { kind: 'text', title: inboxItemLine(item), lines: inboxItemDetail(item) },
        );
        return;
      }
      const n = inbox.data.notifications.notifications[current - items.length];
      if (!n) return;
      if (n.decisionRequest) setView({ kind: 'request', id: n.decisionRequest.id });
      else if (n.type === 'SPEC_VERSION_CREATED' && n.feature) {
        setView({ kind: 'spec', feature: n.feature });
      } else setView({ kind: 'text', title: 'Notification', lines: [notificationLine(n).trim()] });
    } else if (tab === 1 && requests.status === 'ok') {
      const r = requests.data[current];
      if (r) setView({ kind: 'request', id: r.id });
    } else if (tab === 2) {
      const f = featureList[current];
      if (f) setView({ kind: 'spec', feature: f });
    }
  };

  const markRead = (all: boolean) => {
    if (inbox.status !== 'ok') return;
    const n = inbox.data.notifications.notifications[current - inbox.data.items.length];
    if (!all && !n) return;
    setFlash(undefined);
    (all ? api.markAllNotificationsRead() : api.markNotificationRead(n?.id ?? '')).then(
      () => {
        setFlash({ tone: 'ok', text: all ? 'All Notifications marked read.' : 'Marked read.' });
        load(0, true);
      },
      (error) => setFlash({ tone: 'error', text: errorMessage(error) }),
    );
  };

  useInput(
    (input, key) => {
      if (input === 'q') return exit();
      if (input === '?') return setHelp((h) => !h);
      if (input === 'r') return setView({ kind: 'raise' });
      if (key.tab) return switchTab(((tab + (key.shift ? 2 : 1)) % 3) as Tab);
      if (input === '1' || input === '2' || input === '3') {
        return switchTab((Number(input) - 1) as Tab);
      }
      if (key.escape) return setView({ kind: 'list' });
      if (view.kind !== 'list') return;
      setFlash(undefined);
      if (input === 'R') return load(tab);
      if (tab === 0 && (input === 'm' || input === 'M')) return markRead(input === 'M');
      if (input === 'a' && tab === 2 && bound) {
        setShowAll((v) => !v);
        setSelected((s) => [s[0], s[1], 0]);
        return;
      }
      const count = rowsOf[tab].length;
      const move = (delta: number) =>
        setSelected((s) => {
          const next = [...s] as [number, number, number];
          next[tab] = Math.min(Math.max(0, current + delta), Math.max(0, count - 1));
          return next;
        });
      if (key.downArrow || input === 'j') move(1);
      else if (key.upArrow || input === 'k') move(-1);
      else if (key.return) open();
    },
    { isActive: view.kind !== 'raise' && !capture },
  );

  let body: ReactNode;
  if (view.kind === 'raise') {
    body = (
      <RaiseForm
        api={api}
        scope={repo}
        initialFeatureId={tab === 2 ? featureList[current]?.id : undefined}
        onClose={(sent) => {
          setView({ kind: 'list' });
          if (sent && tab === 1) load(1);
        }}
      />
    );
  } else if (view.kind === 'request') {
    body = (
      <RequestScreen
        key={view.id}
        api={api}
        id={view.id}
        height={height}
        meId={meId}
        actHint={view.actHint}
        tick={tick}
        onCapture={onCapture}
        onChanged={refreshAll}
        onOpenProposal={(id) => setView({ kind: 'proposal', proposal: 'spec', id })}
      />
    );
  } else if (view.kind === 'proposal') {
    body = (
      <ProposalScreen
        key={`${view.proposal}:${view.id}`}
        api={api}
        kind={view.proposal}
        id={view.id}
        title={view.title}
        height={height}
        tick={tick}
        onCapture={onCapture}
        onChanged={refreshAll}
      />
    );
  } else if (view.kind === 'spec') {
    body = <SpecScreen api={api} feature={view.feature} height={height} />;
  } else if (view.kind === 'text') {
    body = (
      <Box flexDirection="column">
        <Text bold>{view.title}</Text>
        {view.lines.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>
    );
  } else if (tab === 0) {
    body = (
      <Box flexDirection="column">
        <RemoteStatus state={inbox} />
        {inbox.status === 'ok' && inbox.data.items.length === 0 && (
          <Text dimColor>No Inbox Items: nothing needs you right now.</Text>
        )}
        {inbox.status === 'ok' && (
          <ListView rows={inboxRows} selected={current} height={height} empty="No Notifications." />
        )}
        {inbox.status === 'ok' && inbox.data.notifications.unreadCount > 0 && (
          <Text dimColor>m mark the selected Notification read · M mark all read</Text>
        )}
      </Box>
    );
  } else if (tab === 1) {
    body = (
      <Box flexDirection="column">
        <RemoteStatus state={requests} />
        {requests.status === 'ok' && (
          <ListView
            rows={requestRows}
            selected={current}
            height={height}
            empty="You have not raised any Decision Request yet. Press r to raise one."
          />
        )}
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column">
        <Text dimColor>
          {bound
            ? `Bound to the Project "${boundName || bound}" (.vorasaan/config.json) · a: ${showAll ? 'only this Project' : 'all Projects'}`
            : 'This repository is not bound to a Project: `vorasaan init` scopes this list.'}
        </Text>
        <RemoteStatus state={features} />
        {features.status === 'ok' && (
          <ListView
            rows={featureRows}
            selected={current}
            height={height}
            empty={
              bound && !showAll
                ? 'You are not a Role Owner on any Feature of the bound Project. Press a to see all.'
                : 'You are not a Role Owner on any Feature yet.'
            }
          />
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="magenta">
          vorasaan{' '}
        </Text>
        {TABS.map((name, i) => (
          <Text key={name} inverse={i === tab} bold={i === tab}>
            {' '}
            {i + 1} {name}{' '}
          </Text>
        ))}
        <LiveIndicator status={liveStatus} />
      </Box>
      {repo.notice && <Text color="yellow">{repo.notice}</Text>}
      {liveStatus?.state === 'stopped' && <Text color="red">{liveStatus.reason}</Text>}
      {flash && (
        <Text color={flash.tone === 'ok' ? 'green' : 'red'}>
          {flash.tone === 'ok' ? '✔' : '✖'} {flash.text}
        </Text>
      )}
      <Box flexDirection="column" marginY={1}>
        {body}
      </Box>
      {help ? (
        <Box flexDirection="column">
          {FULL_HELP.map((line) => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
          {notifier && (
            <Text dimColor>
              {notifier.disabledReason ?? 'OS notifications are on (--no-notify turns them off)'}
            </Text>
          )}
        </Box>
      ) : (
        <Text dimColor>{HELP_LINE}</Text>
      )}
    </Box>
  );
}
