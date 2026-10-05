import type {
  AttachmentView,
  BriefProposalView,
  ChoiceDraft,
  CreateRepoScanInput,
  DecideInput,
  DecideResult,
  DecisionRequestView,
  FeatureSummaryView,
  FeatureView,
  InboxItem,
  MeView,
  MyTeamView,
  NotificationList,
  NotificationView,
  PostRequestMessageInput,
  ProjectCoverageView,
  ProjectView,
  RaiseDecisionRequestInput,
  ReadAllNotificationsResult,
  SpecProposalView,
  SpecVersionView,
  SubmitDecisionRequestInput,
  TeamView,
} from '@vorasaan/shared';
import type { Credentials } from './config.ts';

// DEV ONLY: servers with VORASAAN_DEV_AUTH=true accept this header as the caller.
const DEV_USER_HEADER = 'x-vorasaan-user';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turns a NestJS error body ({ message: string | string[] }) into one readable line. */
function readableMessage(status: number, body: unknown): string {
  const message =
    body && typeof body === 'object' && 'message' in body
      ? (body as { message: unknown }).message
      : undefined;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof message === 'string') return message;
  return `Request failed with status ${status}`;
}

export type ApiConfig = { baseUrl: string; credentials: Credentials; fetch?: typeof fetch };

export class VorasaanApi {
  private readonly fetch: typeof fetch;

  constructor(private readonly config: ApiConfig) {
    this.fetch = config.fetch ?? fetch;
  }

  /** The server this client talks to (never includes credentials). */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  me() {
    return this.request<MeView>('GET', '/me');
  }

  listFeatures() {
    return this.request<FeatureSummaryView[]>('GET', '/features');
  }

  feature(id: string) {
    return this.request<FeatureView>('GET', `/features/${encodeURIComponent(id)}`);
  }

  /** Newest first. */
  specVersions(featureId: string) {
    return this.request<SpecVersionView[]>(
      'GET',
      `/features/${encodeURIComponent(featureId)}/spec-versions`,
    );
  }

  /** A Project's Coverage matrix (ticket 0051): each Feature's target Platforms, covered or not. */
  projectCoverage(projectId: string) {
    return this.request<ProjectCoverageView>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/coverage`,
    );
  }

  listProjects() {
    return this.request<ProjectView[]>('GET', '/projects');
  }

  inbox() {
    return this.request<InboxItem[]>('GET', '/inbox');
  }

  notifications() {
    return this.request<NotificationList>('GET', '/notifications');
  }

  /** Decision Requests I raised. */
  myRequests() {
    return this.request<DecisionRequestView[]>('GET', '/decision-requests?raiser=me');
  }

  decisionRequest(id: string) {
    return this.request<DecisionRequestView>('GET', `/decision-requests/${encodeURIComponent(id)}`);
  }

  raise(input: RaiseDecisionRequestInput) {
    return this.request<DecisionRequestView>('POST', '/decision-requests', input);
  }

  submit(id: string, input: SubmitDecisionRequestInput) {
    return this.request<DecisionRequestView>('POST', `/decision-requests/${id}/submit`, input);
  }

  withdraw(id: string) {
    return this.request<DecisionRequestView>('POST', `/decision-requests/${id}/withdraw`);
  }

  claim(id: string) {
    return this.request<DecisionRequestView>('POST', `/decision-requests/${id}/claim`);
  }

  /** Hand an OPEN request to another holder of the decider role. */
  reassign(id: string, userId: string) {
    return this.request<DecisionRequestView>('POST', `/decision-requests/${id}/reassign`, {
      userId,
    });
  }

  /** QUESTION (ask for info), ANSWER (the Raiser) or NOTE. */
  postMessage(id: string, input: PostRequestMessageInput) {
    return this.request<DecisionRequestView>('POST', `/decision-requests/${id}/messages`, input);
  }

  decide(id: string, input: DecideInput) {
    return this.request<DecideResult>('POST', `/decision-requests/${id}/decision`, input);
  }

  team(id: string) {
    return this.request<TeamView>('GET', `/teams/${encodeURIComponent(id)}`);
  }

  /** My Teams, each with its members' Team Roles, in one request. */
  myTeams() {
    return this.request<MyTeamView[]>('GET', '/me/teams');
  }

  specProposal(id: string) {
    return this.request<SpecProposalView>('GET', `/spec-proposals/${encodeURIComponent(id)}`);
  }

  approveSpecProposal(id: string) {
    return this.request<unknown>('POST', `/spec-proposals/${encodeURIComponent(id)}/approve`);
  }

  rejectSpecProposal(id: string) {
    return this.request<unknown>('POST', `/spec-proposals/${encodeURIComponent(id)}/reject`);
  }

  briefProposal(id: string) {
    return this.request<BriefProposalView>('GET', `/brief-proposals/${encodeURIComponent(id)}`);
  }

  approveBriefProposal(id: string) {
    return this.request<unknown>('POST', `/brief-proposals/${encodeURIComponent(id)}/approve`);
  }

  rejectBriefProposal(id: string) {
    return this.request<unknown>('POST', `/brief-proposals/${encodeURIComponent(id)}/reject`);
  }

  markNotificationRead(id: string) {
    return this.request<NotificationView>('POST', `/notifications/${encodeURIComponent(id)}/read`);
  }

  markAllNotificationsRead() {
    return this.request<ReadAllNotificationsResult>('POST', '/notifications/read-all');
  }

  /**
   * Opens `GET /events` (Server-Sent Events) on the configured server, the only place
   * the credentials are ever sent. Resolves with the streaming response; a non-2xx
   * status becomes an ApiError so the caller can stop on 401/403.
   */
  async openEvents(signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetch(new URL('/events', this.config.baseUrl), {
        headers: { ...this.authHeaders(), accept: 'text/event-stream' },
        // Never follow a redirect with the token to another host.
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError(0, `Cannot reach the Vorasaan server at ${this.config.baseUrl}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      throw new ApiError(res.status, readableMessage(res.status, parsed));
    }
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError(res.status, `Unexpected response from ${this.config.baseUrl}/events`);
    }
    return res;
  }

  private authHeaders(): Record<string, string> {
    return 'token' in this.config.credentials
      ? { authorization: `Bearer ${this.config.credentials.token}` }
      : { [DEV_USER_HEADER]: this.config.credentials.devUserId };
  }

  postRepoScan(projectId: string, input: CreateRepoScanInput) {
    return this.request<AttachmentView>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/repo-scans`,
      input,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(new URL(path, this.config.baseUrl), {
        method,
        headers: {
          ...this.authHeaders(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, `Cannot reach the Vorasaan server at ${this.config.baseUrl}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // A proxy or a non-Vorasaan server answered: report it, never crash on the body.
      throw new ApiError(
        res.status,
        res.ok
          ? `Unexpected response from ${this.config.baseUrl}${path}`
          : `Request failed with status ${res.status}`,
      );
    }
    if (!res.ok) throw new ApiError(res.status, readableMessage(res.status, parsed));
    return parsed as T;
  }
}

export type { ChoiceDraft };
