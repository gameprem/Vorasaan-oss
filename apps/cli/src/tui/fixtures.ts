import type {
  DecisionRequestView,
  FeatureSummaryView,
  InboxItem,
  NotificationList,
  RaiseDecisionRequestInput,
  SpecVersionView,
  SubmitDecisionRequestInput,
} from '@vorasaan/shared';
import type { TuiApi } from './App.tsx';

/** Test data and an in-memory fake of the server, so TUI tests never touch the network. */

export const PROJECT_A = '00000000-0000-4000-8000-00000000000a';
export const PROJECT_B = '00000000-0000-4000-8000-00000000000b';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-09-30T10:00:00.000Z';
const person = (n: number, name: string) => ({ id: id(n), name });

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
    },
  },
  {
    kind: 'ANSWER_GRILLING',
    project: { id: PROJECT_A, name: 'Mobile Banking' },
    since: at,
    grilling: { id: id(501), round: 'TECHNICAL', role: 'BACKEND', unanswered: 3 },
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
    createdAt: at,
  }));
}

export type FakeCalls = {
  raised: RaiseDecisionRequestInput[];
  submitted: { id: string; input: SubmitDecisionRequestInput }[];
  withdrawn: string[];
  loads: string[];
};

/** A fake TuiApi; `fail` makes the named method reject like an unreachable server. */
export function fakeApi(
  options: { fail?: (keyof TuiApi)[]; myRequests?: DecisionRequestView[] } = {},
): { api: TuiApi; calls: FakeCalls } {
  const calls: FakeCalls = { raised: [], submitted: [], withdrawn: [], loads: [] };
  const guard = async <T>(name: keyof TuiApi, value: () => T): Promise<T> => {
    calls.loads.push(name);
    if (options.fail?.includes(name)) {
      throw new Error('Cannot reach the Vorasaan server at http://api.test');
    }
    return value();
  };
  const api: TuiApi = {
    inbox: () => guard('inbox', () => inboxItems),
    notifications: () => guard('notifications', () => notifications),
    myRequests: () => guard('myRequests', () => options.myRequests ?? [request()]),
    listFeatures: () => guard('listFeatures', () => features),
    specVersions: (featureId) => guard('specVersions', () => specVersions(featureId)),
    decisionRequest: (requestId) =>
      guard('decisionRequest', () =>
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
        return request({ id: requestId, status: 'WITHDRAWN' });
      }),
  };
  return { api, calls };
}
