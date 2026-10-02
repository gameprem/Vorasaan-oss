import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ApiError, VorasaanApi } from './api.ts';

describe('VorasaanApi', () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { method: string; path: string; user: string | null; body: unknown }[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
        seen.push({
          method: req.method,
          path: url.pathname,
          user: req.headers.get('x-vorasaan-user'),
          body,
        });
        if (url.pathname === '/features') return Response.json([{ id: 'f-1', title: 'Async' }]);
        if (url.pathname === '/decision-requests/bad/submit') {
          return Response.json(
            {
              statusCode: 422,
              message: 'Expected exactly one PO Role Owner on this Feature, found 2',
            },
            { status: 422 },
          );
        }
        if (url.pathname === '/decision-requests') {
          return Response.json(
            { statusCode: 400, message: ['title: Too small', 'kind: Invalid option'] },
            { status: 400 },
          );
        }
        return new Response('not found', { status: 404 });
      },
    });
  });

  afterAll(() => server.stop());

  const api = () =>
    new VorasaanApi({ baseUrl: server.url.toString(), credentials: { devUserId: 'beam' } });

  test('sends the dev identity header and parses JSON', async () => {
    expect(await api().listFeatures()).toEqual([{ id: 'f-1', title: 'Async' }] as never);
    expect(seen.at(-1)).toMatchObject({ method: 'GET', path: '/features', user: 'beam' });
  });

  test('sends JSON bodies', async () => {
    await api()
      .submit('bad', { deciderRole: 'PO' })
      .catch(() => {});
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      path: '/decision-requests/bad/submit',
      body: { deciderRole: 'PO' },
    });
  });

  test('turns server errors into readable ApiErrors', async () => {
    const error = await api()
      .submit('bad', { deciderRole: 'PO' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).message).toBe(
      'Expected exactly one PO Role Owner on this Feature, found 2',
    );

    const validation = await api()
      .raise({ featureId: 'x', kind: 'BLOCKER', title: '', description: 'd' })
      .catch((e: unknown) => e);
    expect((validation as ApiError).message).toBe('title: Too small; kind: Invalid option');
  });

  test('reports an unreachable server clearly', async () => {
    const offline = new VorasaanApi({
      baseUrl: 'http://127.0.0.1:1',
      credentials: { devUserId: 'beam' },
    });
    const error = await offline.listFeatures().catch((e: unknown) => e);
    expect((error as ApiError).message).toContain('Cannot reach the Vorasaan server');
  });
});

describe('VorasaanApi actions and the event stream', () => {
  const R = '00000000-0000-4000-8000-000000000301';
  const U = '00000000-0000-4000-8000-000000000005';

  function recording(response: () => Response = () => Response.json({})) {
    const seen: {
      method: string;
      url: string;
      headers: Headers;
      body: unknown;
      redirect?: RequestInit['redirect'];
    }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        redirect: init?.redirect,
      });
      return response();
    }) as typeof fetch;
    const api = new VorasaanApi({
      baseUrl: 'http://api.test',
      credentials: { token: 'vsp_secret' },
      fetch: fetchImpl,
    });
    return { api, seen };
  }

  test('each action calls its endpoint with its body', async () => {
    const { api, seen } = recording();
    await api.claim(R);
    await api.reassign(R, U);
    await api.postMessage(R, { kind: 'QUESTION', body: 'Which provider?' });
    await api.decide(R, { choiceId: U, rationale: 'Cheapest' });
    await api.decide(R, { customAnswer: 'Neither' });
    await api.withdraw(R);
    await api.team(U);
    await api.myTeams();
    await api.specProposal(U);
    await api.approveSpecProposal(U);
    await api.rejectSpecProposal(U);
    await api.briefProposal(U);
    await api.approveBriefProposal(U);
    await api.rejectBriefProposal(U);
    await api.markNotificationRead(U);
    await api.markAllNotificationsRead();
    expect(seen.map((s) => `${s.method} ${s.url.replace('http://api.test', '')}`)).toEqual([
      `POST /decision-requests/${R}/claim`,
      `POST /decision-requests/${R}/reassign`,
      `POST /decision-requests/${R}/messages`,
      `POST /decision-requests/${R}/decision`,
      `POST /decision-requests/${R}/decision`,
      `POST /decision-requests/${R}/withdraw`,
      `GET /teams/${U}`,
      'GET /me/teams',
      `GET /spec-proposals/${U}`,
      `POST /spec-proposals/${U}/approve`,
      `POST /spec-proposals/${U}/reject`,
      `GET /brief-proposals/${U}`,
      `POST /brief-proposals/${U}/approve`,
      `POST /brief-proposals/${U}/reject`,
      `POST /notifications/${U}/read`,
      'POST /notifications/read-all',
    ]);
    expect(seen.map((s) => s.body).filter(Boolean)).toEqual([
      { userId: U },
      { kind: 'QUESTION', body: 'Which provider?' },
      { choiceId: U, rationale: 'Cheapest' },
      { customAnswer: 'Neither' },
    ]);
    expect(seen.every((s) => s.headers.get('authorization') === 'Bearer vsp_secret')).toBe(true);
  });

  test('openEvents sends the token to the configured server only and asks for SSE', async () => {
    const { api, seen } = recording(
      () => new Response(': connected\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
    const res = await api.openEvents(new AbortController().signal);
    expect(await res.text()).toBe(': connected\n\n');
    expect(seen[0]?.url).toBe('http://api.test/events');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer vsp_secret');
    expect(seen[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(seen[0]?.redirect).toBe('error');
  });

  test('openEvents turns 401 and non-SSE answers into ApiError', async () => {
    const denied = recording(() =>
      Response.json({ statusCode: 401, message: 'Unauthorized' }, { status: 401 }),
    );
    const error = await denied.api.openEvents(new AbortController().signal).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);

    const html = recording(
      () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(html.api.openEvents(new AbortController().signal)).rejects.toThrow(
      'Unexpected response from http://api.test/events',
    );
  });
});
