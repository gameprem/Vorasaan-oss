import type {
  DecisionRequestView,
  FeatureSummaryView,
  InboxItem,
  NotificationList,
  SpecVersionView,
} from '@vorasaan/shared';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { VorasaanApi } from '../api.ts';
import type { RepoScope } from '../commands/raise-flow.ts';
import { ListView, type Row, ScrollText } from './components.tsx';
import {
  errorMessage,
  inboxItemDetail,
  inboxItemLine,
  inboxItemRequestId,
  notificationLine,
  requestDetail,
  requestLine,
} from './format.ts';
import { RaiseForm } from './RaiseForm.tsx';

/** What the TUI needs from the server; tests pass a fake. */
export type TuiApi = Pick<
  VorasaanApi,
  | 'inbox'
  | 'notifications'
  | 'myRequests'
  | 'listFeatures'
  | 'specVersions'
  | 'decisionRequest'
  | 'raise'
  | 'submit'
  | 'withdraw'
>;

export type TuiRepo = RepoScope & { notice?: string };

type Remote<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string };

type InboxData = { items: InboxItem[]; notifications: NotificationList };

const TABS = ['Inbox', 'My Requests', 'Features'] as const;
type Tab = 0 | 1 | 2;

type View =
  | { kind: 'list' }
  | { kind: 'request'; id: string }
  | { kind: 'spec'; feature: { id: string; title: string } }
  | { kind: 'text'; title: string; lines: string[] }
  | { kind: 'raise' };

export const HELP_LINE =
  'Tab/1-3 switch · ↑↓/j/k move · Enter open · Esc back · r raise · R refresh · ? help · q quit';

const FULL_HELP = [
  'Tab / Shift-Tab or 1 2 3  switch tabs (refreshes the tab)',
  '↑ ↓ or j k                move; in a Spec or request: scroll (space/b page, g/G ends)',
  'Enter                     open the selected item · Esc  back to the list',
  'r                         raise a Blocker or Question with context from this repository',
  'R                         refresh · a  (Features) all Projects / only the bound Project',
  'q or Ctrl-C               quit',
];

/** Loads once per `key` (e.g. the id being shown); a failure becomes a message. */
function useRemote<T>(load: () => Promise<T>, key: string): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ status: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload exactly when the key changes
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadRef.current().then(
      (data) => live && setState({ status: 'ok', data }),
      (error) => live && setState({ status: 'error', message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

function RemoteStatus({ state }: { state: Remote<unknown> }) {
  if (state.status === 'loading') return <Text dimColor>Loading…</Text>;
  if (state.status === 'error') {
    return <Text color="red">✖ {state.message} (R to retry)</Text>;
  }
  return null;
}

function RequestScreen({ api, id, height }: { api: TuiApi; id: string; height: number }) {
  const state = useRemote<DecisionRequestView>(() => api.decisionRequest(id), id);
  if (state.status !== 'ok') return <RemoteStatus state={state} />;
  return (
    <Box flexDirection="column">
      <Text bold>{state.data.title}</Text>
      <ScrollText lines={requestDetail(state.data)} height={height} />
    </Box>
  );
}

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

export function App({
  api,
  repo,
  height: fixedHeight,
}: {
  api: TuiApi;
  repo: TuiRepo;
  /** Rows for lists and text; defaults to the terminal height. */
  height?: number;
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

  // Every load settles into state; a failed request becomes a message, never a crash.
  const load = useCallback(
    (which: Tab) => {
      const settle = <T,>(set: (r: Remote<T>) => void, promise: Promise<T>) => {
        set({ status: 'loading' });
        promise.then(
          (data) => set({ status: 'ok', data }),
          (error) => set({ status: 'error', message: errorMessage(error) }),
        );
      };
      if (which === 0) {
        settle(
          setInbox,
          Promise.all([api.inbox(), api.notifications()]).then(([items, notifications]) => ({
            items,
            notifications,
          })),
        );
      } else if (which === 1) settle(setRequests, api.myRequests());
      else settle(setFeatures, api.listFeatures());
    },
    [api],
  );

  useEffect(() => {
    load(tab);
  }, [tab, load]);

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
        const requestId = inboxItemRequestId(item);
        setView(
          requestId
            ? { kind: 'request', id: requestId }
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
      if (input === 'R') return load(tab);
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
    { isActive: view.kind !== 'raise' },
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
    body = <RequestScreen api={api} id={view.id} height={height} />;
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
      </Box>
      {repo.notice && <Text color="yellow">{repo.notice}</Text>}
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
        </Box>
      ) : (
        <Text dimColor>{HELP_LINE}</Text>
      )}
    </Box>
  );
}
