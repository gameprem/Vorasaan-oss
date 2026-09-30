import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fetchUrl, isPrivateAddress, UrlFetchError } from './fetch-url.ts';

describe('isPrivateAddress', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:0.0.0.0',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1',
    'fd00::1',
    'fe80::1%eth0',
    'not-an-ip',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(['1.1.1.1', '93.184.215.14', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('fetchUrl', () => {
  let server: ReturnType<typeof Bun.serve>;
  const open = { maxBytes: 1000, allowPrivate: true };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/page') {
          return new Response('<p>hi</p>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (path === '/moved') return Response.redirect('/page', 302);
        if (path === '/loop') return Response.redirect('/loop', 302);
        if (path === '/huge') {
          // Streamed without a Content-Length, so the cap must hold while reading.
          const chunk = new Uint8Array(400);
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(chunk);
              },
            }),
            { headers: { 'content-type': 'text/plain' } },
          );
        }
        return new Response('nope', { status: 404 });
      },
    });
  });

  afterAll(() => server.stop(true));

  const at = (path: string) => `${server.url.origin}${path}`;

  test('reads a page and its media type, following redirects', async () => {
    const page = await fetchUrl(at('/moved'), open);
    expect(page.url).toBe(at('/page'));
    expect(page.mimeType).toBe('text/html');
    expect(new TextDecoder().decode(page.bytes)).toBe('<p>hi</p>');
  });

  test('refuses private addresses unless allowed', async () => {
    const closed = { maxBytes: 1000, allowPrivate: false };
    await expect(fetchUrl(at('/page'), closed)).rejects.toThrow('not a public address');
    await expect(fetchUrl(`http://localhost:${server.port}/page`, closed)).rejects.toThrow(
      'not a public address',
    );
    await expect(fetchUrl('http://[::1]/', closed)).rejects.toBeInstanceOf(UrlFetchError);
    await expect(fetchUrl('http://169.254.169.254/latest/', closed)).rejects.toThrow(
      'not a public address',
    );
  });

  test('refuses other schemes, credentials, errors, loops and oversized bodies', async () => {
    await expect(fetchUrl('file:///etc/passwd', open)).rejects.toThrow('Only http and https');
    await expect(fetchUrl(`http://u:p@127.0.0.1:${server.port}/page`, open)).rejects.toThrow(
      'credentials',
    );
    await expect(fetchUrl(at('/missing'), open)).rejects.toThrow('HTTP 404');
    await expect(fetchUrl(at('/loop'), open)).rejects.toThrow('Too many redirects');
    await expect(fetchUrl(at('/huge'), open)).rejects.toThrow('larger than 1000 bytes');
  });
});
