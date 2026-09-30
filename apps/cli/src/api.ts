import type {
  ChoiceDraft,
  DecisionRequestView,
  FeatureSummaryView,
  MeView,
  RaiseDecisionRequestInput,
  SubmitDecisionRequestInput,
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

  me() {
    return this.request<MeView>('GET', '/me');
  }

  listFeatures() {
    return this.request<FeatureSummaryView[]>('GET', '/features');
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(new URL(path, this.config.baseUrl), {
        method,
        headers: {
          ...('token' in this.config.credentials
            ? { authorization: `Bearer ${this.config.credentials.token}` }
            : { [DEV_USER_HEADER]: this.config.credentials.devUserId }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, `Cannot reach the Vorasaan server at ${this.config.baseUrl}`);
    }
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, readableMessage(res.status, parsed));
    return parsed as T;
  }
}

export type { ChoiceDraft };
