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

  const api = () => new VorasaanApi({ baseUrl: server.url.toString(), userId: 'beam' });

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
    const offline = new VorasaanApi({ baseUrl: 'http://127.0.0.1:1', userId: 'beam' });
    const error = await offline.listFeatures().catch((e: unknown) => e);
    expect((error as ApiError).message).toContain('Cannot reach the Vorasaan server');
  });
});
