import type {
  BriefProposalView,
  DecisionRequestView,
  FeatureSummaryView,
  InboxItem,
  MyTeamView,
  NotificationList,
  ProjectCoverageView,
  RaiseDecisionRequestInput,
  SpecProposalView,
  SpecVersionView,
  SubmitDecisionRequestInput,
  TeamView,
} from '@vorasaan/shared';
import { ApiError } from '../api.ts';
import type { TuiApi } from './App.tsx';

/** Test data and an in-memory fake of the server, so TUI tests never touch the network. */

export const PROJECT_A = '00000000-0000-4000-8000-00000000000a';
export const PROJECT_B = '00000000-0000-4000-8000-00000000000b';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-09-30T10:00:00.000Z';
const person = (n: number, name: string) => ({ id: id(n), name });
/** A request with no Response Window labels (its dueAt is unknown). */
export const NO_WINDOW = { dueAt: null, paused: false, escalationStep: 0 };

export const features: FeatureSummaryView[] = [
  {
    id: id(101),
    title: 'Async checkout',
    teamId: id(201),
    teamName: 'Checkout',
    projectId: PROJECT_A,
    projectName: 'Mobile Banking',
    myRoles: ['BACKEND'],
  },
  {
    id: id(102),
    title: 'Loyalty points',
    teamId: id(202),
    teamName: 'Growth',
    projectId: PROJECT_B,
    projectName: 'Web Shop',
    myRoles: ['FRONTEND'],
  },
];

/**
 * GET /projects/:id/coverage: Async checkout (Mobile Banking) targets Back-End, covered, and
 * Flutter, missing its Spec section; Web Shop's Features target nothing.
 */
export function projectCoverage(projectId: string): ProjectCoverageView {
  const backEnd = { id: id(401), name: 'Back-End' };
  const flutter = { id: id(402), name: 'Flutter' };
  if (projectId !== PROJECT_A) {
    return { projectId, platforms: [], features: [], uncovered: [] };
  }
  return {
    projectId,
    platforms: [backEnd, flutter],
    uncovered: [flutter],
    features: [
      {
        featureId: id(101),
        title: 'Async checkout',
        teamId: id(201),
        teamName: 'Checkout',
        specVersion: 2,
        covered: false,
        platforms: [
          { platform: backEnd, covered: true, checks: ['SPEC_SECTION'], missing: [] },
          {
            platform: flutter,
            covered: false,
            checks: ['SPEC_SECTION'],
            missing: [{ check: 'SPEC_SECTION' }],
          },
        ],
      },
    ],
  };
}

export function request(overrides: Partial<DecisionRequestView> = {}): DecisionRequestView {
  return {
    id: id(301),
    featureId: id(101),
    featureTitle: 'Async checkout',
    kind: 'BLOCKER',
    status: 'OPEN',
    withChoices: true,
    title: 'Provider has no webhook',
    description: 'Only polling is available.',
    raiser: person(1, 'Beam'),
    suggestedRole: 'PO',
    deciderRole: 'PO',
    decider: person(2, 'Pim'),
    recipients: [person(2, 'Pim')],
    canClaim: false,
    choices: [
      {
        id: id(401),
        position: 0,
        editedByUser: false,
        label: 'A',
        title: 'Poll every minute',
        description: 'Cheap and slow.',
        impactScope: 'Small',
        impactTime: '+1 day',
        impactRisk: 'Low',
      },
      {
        id: id(402),
        position: 1,
        editedByUser: false,
        label: 'B',
        title: 'Switch provider',
        description: 'Costly.',
        impactScope: 'Large',
        impactTime: '+2 weeks',
        impactRisk: 'High',
      },
    ],
    messages: [],
    decision: null,
    specProposal: null,
    submittedAt: at,
    responseWindow: NO_WINDOW,
    history: [],
    createdAt: at,
    ...overrides,
  };
}

export const inboxItems: InboxItem[] = [
  {
    kind: 'DECIDE',
    feature: { id: id(101), title: 'Async checkout' },
    since: at,
    decisionRequest: {
      id: id(302),
      title: 'Which retry policy?',
      kind: 'QUESTION',
      raiser: person(3, 'Fah'),
      deciderRole: 'BACKEND',
      onBehalfOf: null,
      responseWindow: NO_WINDOW,
    },
  },
  {
    kind: 'ANSWER_GRILLING',
    project: { id: PROJECT_A, name: 'Mobile Banking' },
    since: at,
    grilling: {
      id: id(501),
      round: 'TECHNICAL',
      role: 'BACKEND',
      unanswered: 3,
      conversationId: null,
    },
  },
];

export const notifications: NotificationList = {
  unreadCount: 1,
  notifications: [
    {
      id: id(601),
      type: 'SPEC_VERSION_CREATED',
      feature: { id: id(101), title: 'Async checkout' },
      decisionRequest: null,
      specVersion: { id: id(701), version: 2, approvedBy: person(2, 'Pim') },
      delegation: null,
      readAt: null,
      createdAt: at,
    },
  ],
};

export const specMarkdown = Array.from({ length: 40 }, (_, i) => `Spec line ${i + 1}`).join('\n');

export function specVersions(featureId: string): SpecVersionView[] {
  return [1, 2].map((version) => ({
    id: id(700 + version),
    featureId,
    version,
    markdown: version === 2 ? specMarkdown : 'old spec',
    source: 'MANUAL',
    summary: version === 2 ? 'Retry policy' : null,
    approvedBy: person(2, 'Pim'),
    revertedFrom: null,
    draftedWith: null,
    createdAt: at,
  }));
}

export const ME = person(1, 'Beam');
export const SPEC_PROPOSAL_ID = id(801);
export const BRIEF_PROPOSAL_ID = id(802);
export const TEAM_ID = id(201);

export function specProposal(overrides: Partial<SpecProposalView> = {}): SpecProposalView {
  return {
    id: SPEC_PROPOSAL_ID,
    featureId: id(101),
    source: 'DECISION',
    status: 'PENDING',
    approver: person(1, 'Beam'),
    baseVersion: 2,
    baseMarkdown: '# Async checkout\nPoll the provider.\nKeep receipts.\n',
    proposedMarkdown: '# Async checkout\nPoll every minute.\nKeep receipts.\nRetry twice.\n',
    decisionRequestId: id(301),
    draftedWith: null,
    createdAt: at,
    ...overrides,
  };
}

export function briefProposal(overrides: Partial<BriefProposalView> = {}): BriefProposalView {
  return {
    id: BRIEF_PROPOSAL_ID,
    projectId: PROJECT_A,
    source: 'GRILLING',
    status: 'PENDING',
    approver: person(1, 'Beam'),
    baseVersion: 1,
    baseMarkdown: '# Brief\nOld goal\n',
    proposedMarkdown: '# Brief\nNew goal\n',
    summary: 'Sharper goal',
    resultVersion: null,
    draftedWith: null,
    createdAt: at,
    ...overrides,
  };
}

export const team: TeamView = {
  id: TEAM_ID,
  name: 'Checkout',
  project: { id: PROJECT_A, name: 'Mobile Banking' },
  members: [
    { userId: id(1), name: 'Beam', email: 'beam@acme.test', roles: ['BACKEND'] },
    { userId: id(2), name: 'Pim', email: 'pim@acme.test', roles: ['PO'] },
    { userId: id(5), name: 'Nok', email: 'nok@acme.test', roles: ['PO', 'QA'] },
  ],
  features: [],
  canManage: false,
};

/** GET /me/teams for Beam: the Checkout Team. */
export const myTeams: MyTeamView[] = [
  {
    id: team.id,
    name: team.name,
    project: team.project,
    myRoles: ['BACKEND'],
    members: team.members,
  },
];

export type FakeCalls = {
  raised: RaiseDecisionRequestInput[];
  submitted: { id: string; input: SubmitDecisionRequestInput }[];
  withdrawn: string[];
  loads: string[];
  /** Every action: method name and its arguments. */
  actions: { name: string; args: unknown[] }[];
};

export type FakeOptions = {
  fail?: (keyof TuiApi)[];
  /** Reject the named method like the server would (status and message). */
  reject?: Partial<Record<keyof TuiApi, { status: number; message: string }>>;
  myRequests?: DecisionRequestView[];
  /** What GET /decision-requests/:id returns, by id (else a default OPEN request). */
  requests?: Record<string, DecisionRequestView>;
  inbox?: InboxItem[];
  notifications?: NotificationList;
  specProposal?: SpecProposalView;
  briefProposal?: BriefProposalView;
};

/** A fake TuiApi; `fail` makes the named method reject like an unreachable server. */
export function fakeApi(options: FakeOptions = {}): { api: TuiApi; calls: FakeCalls } {
  const calls: FakeCalls = { raised: [], submitted: [], withdrawn: [], loads: [], actions: [] };
  const guard = async <T>(name: keyof TuiApi, value: () => T): Promise<T> => {
    calls.loads.push(name);
    if (options.fail?.includes(name)) {
      throw new Error('Cannot reach the Vorasaan server at http://api.test');
    }
    const rejection = options.reject?.[name];
    if (rejection) throw new ApiError(rejection.status, rejection.message);
    return value();
  };
  const action = <T>(name: keyof TuiApi, args: unknown[], value: () => T) =>
    guard(name, () => {
      calls.actions.push({ name, args });
      return value();
    });
  const api: TuiApi = {
    me: () => guard('me', () => ({ ...ME, email: 'beam@acme.test', isAdmin: false })),
    inbox: () => guard('inbox', () => options.inbox ?? inboxItems),
    notifications: () => guard('notifications', () => options.notifications ?? notifications),
    myRequests: () => guard('myRequests', () => options.myRequests ?? [request()]),
    listFeatures: () => guard('listFeatures', () => features),
    projectCoverage: (projectId) => guard('projectCoverage', () => projectCoverage(projectId)),
    feature: (featureId) =>
      guard('feature', () => ({
        ...(features.find((f) => f.id === featureId) ?? (features[0] as FeatureSummaryView)),
        jiraIssueKey: null,
        jiraIssueUrl: null,
        openBlockers: 0,
        platforms: [],
      })),
    team: () => guard('team', () => team),
    myTeams: () => guard('myTeams', () => myTeams),
    specVersions: (featureId) => guard('specVersions', () => specVersions(featureId)),
    decisionRequest: (requestId) =>
      guard(
        'decisionRequest',
        () =>
          options.requests?.[requestId] ??
          request(
            requestId === id(302)
              ? { id: requestId, title: 'Which retry policy?', kind: 'QUESTION' }
              : { id: requestId },
          ),
      ),
    raise: (input) =>
      guard('raise', () => {
        calls.raised.push(input);
        return request({
          id: id(399),
          status: 'DRAFT',
          title: input.title,
          description: input.description,
          decider: null,
          recipients: [],
          suggestedRole: 'TECH_LEAD',
        });
      }),
    submit: (requestId, input) =>
      guard('submit', () => {
        calls.submitted.push({ id: requestId, input });
        return request({ id: requestId, status: 'OPEN', decider: person(4, 'Tee') });
      }),
    withdraw: (requestId) =>
      guard('withdraw', () => {
        calls.withdrawn.push(requestId);
        calls.actions.push({ name: 'withdraw', args: [requestId] });
        return request({ id: requestId, status: 'WITHDRAWN' });
      }),
    claim: (requestId) => action('claim', [requestId], () => request({ id: requestId })),
    reassign: (requestId, userId) =>
      action('reassign', [requestId, userId], () => request({ id: requestId })),
    postMessage: (requestId, input) =>
      action('postMessage', [requestId, input], () => request({ id: requestId })),
    decide: (requestId, input) =>
      action('decide', [requestId, input], () => ({
        request: request({ id: requestId, status: 'DECIDED' }),
        proposal: specProposal(),
      })),
    specProposal: () => guard('specProposal', () => options.specProposal ?? specProposal()),
    approveSpecProposal: (proposalId) => action('approveSpecProposal', [proposalId], () => ({})),
    rejectSpecProposal: (proposalId) => action('rejectSpecProposal', [proposalId], () => ({})),
    briefProposal: () => guard('briefProposal', () => options.briefProposal ?? briefProposal()),
    approveBriefProposal: (proposalId) => action('approveBriefProposal', [proposalId], () => ({})),
    rejectBriefProposal: (proposalId) => action('rejectBriefProposal', [proposalId], () => ({})),
    markNotificationRead: (notificationId) =>
      action('markNotificationRead', [notificationId], () => {
        const n = notifications.notifications[0];
        if (!n) throw new Error('no notification');
        return { ...n, readAt: at };
      }),
    markAllNotificationsRead: () => action('markAllNotificationsRead', [], () => ({ updated: 1 })),
  };
  return { api, calls };
}
