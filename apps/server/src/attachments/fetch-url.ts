import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** The URL can't be captured (bad address, HTTP error, too large, wrong type...). */
export class UrlFetchError extends Error {}

export type FetchedPage = { url: string; mimeType: string; bytes: Uint8Array };

export type FetchOptions = {
  maxBytes: number;
  /** Off by default: private, loopback and link-local addresses are refused (SSRF). */
  allowPrivate: boolean;
  timeoutMs?: number;
};

const MAX_REDIRECTS = 5;

/**
 * GETs a public web page for a Snapshot. Guards against SSRF: only http(s), no
 * credentials in the URL, and every hop (redirects are followed by hand) must
 * resolve to public addresses only. The body is read up to `maxBytes`.
 *
 * Known limit: the address is checked before the request, and the request
 * resolves the name again, so a DNS-rebinding host could still slip through.
 */
export async function fetchUrl(input: string, options: FetchOptions): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let url = new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertFetchable(url, options.allowPrivate);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'text/html, text/plain, text/markdown, application/pdf;q=0.9, */*;q=0.1',
          'user-agent': 'Vorasaan (Attachment Snapshot)',
        },
      });
    } catch (error) {
      const reason =
        (error as Error).name === 'TimeoutError' ? 'it timed out' : 'it is unreachable';
      throw new UrlFetchError(`Could not fetch ${url.host}: ${reason}`);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new UrlFetchError(`The page answered HTTP ${response.status}`);
    }
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    return {
      url: url.toString(),
      mimeType: mimeType.toLowerCase(),
      bytes: await readCapped(response, options.maxBytes),
    };
  }
  throw new UrlFetchError('Too many redirects');
}

async function assertFetchable(url: URL, allowPrivate: boolean) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlFetchError('Only http and https URLs can be attached');
  }
  if (url.username || url.password) {
    throw new UrlFetchError('URLs with credentials can’t be attached');
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new UrlFetchError(`Could not resolve ${url.hostname}`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UrlFetchError(`${url.hostname} is not a public address`);
  }
}

export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new UrlFetchError(`The page is larger than ${maxBytes} bytes`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      // Leaving the loop early cancels the stream.
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ─── Address ranges ────────────────────────────────────────────────────────

/** IPv4 ranges that are not the public internet (RFC 6890 and friends). */
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function inV4Range(ip: string, [base, bits]: [string, number]): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(v4ToInt(ip) / size) === Math.floor(v4ToInt(base) / size);
}

/** Expands an IPv6 address to its eight 16-bit groups (handles "::" and a trailing IPv4). */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase().split('%')[0] ?? '';
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4) {
    const n = v4ToInt(v4);
    text = `${text.slice(0, -v4.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (s: string) => (s ? s.split(':').map((g) => Number.parseInt(g, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((range) => inV4Range(ip, range));
  if (isIP(ip) !== 6) return true;
  const g = v6Groups(ip);
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const embeddedV4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible) and 64:ff9b::a.b.c.d (NAT64)
  // carry an IPv4 address.
  const compatible = g5 === 0 && (g6 !== 0 || g7 > 1); // not :: or ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g5 === 0xffff || compatible)) {
    return isPrivateAddress(embeddedV4);
  }
  if (g0 === 0x64 && g[1] === 0xff9b) return isPrivateAddress(embeddedV4);
  return (
    g.every((x) => x === 0) || // ::
    (g.slice(0, 7).every((x) => x === 0) && g7 === 1) || // ::1
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xff00) === 0xff00 || // ff00::/8 multicast
    (g0 === 0x2001 && g[1] === 0x0db8) // 2001:db8::/32 documentation
  );
}
