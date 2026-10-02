import { describe, expect, test } from 'bun:test';
import { makePdf } from '../test/pdf.ts';
import { htmlToText } from './html-to-text.ts';
import {
  matchesMimeType,
  mimeTypeForFileName,
  snapshotText,
  TRUNCATION_MARKER,
  UnreadableContentError,
} from './snapshot-text.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('htmlToText', () => {
  test('keeps readable text and structure, drops scripts, styles and chrome', () => {
    const { title, text } = htmlToText(`<!doctype html>
      <html><head><title> Payments &amp; refunds </title><style>p{color:red}</style></head>
      <body>
        <nav><a href="/">Home</a></nav>
        <h1>Provider   limits</h1>
        <p>Polling every <b>30&nbsp;s</b> is allowed.</p>
        <ul><li>One</li><li>Two &lt;three&gt;</li></ul>
        <script>alert('x')</script>
        <footer>© Acme</footer>
      </body></html>`);
    expect(title).toBe('Payments & refunds');
    expect(text).toBe(
      '# Provider limits\n\nPolling every 30 s is allowed.\n\n- One\n- Two <three>',
    );
  });

  test('prefers <main> or <article> when present', () => {
    const { text } = htmlToText(
      '<body><div>Sidebar junk</div><article><p>The real content</p></article></body>',
    );
    expect(text).toBe('The real content');
  });

  test('keeps whitespace inside <pre>', () => {
    const { text } = htmlToText('<p>Code:</p><pre>a  b\n  c</pre>');
    expect(text).toContain('a  b\n  c');
  });
});

describe('snapshotText', () => {
  test('Markdown and plain text are kept as-is', async () => {
    const md = '# Title\n\n  indented *text* — ünïcode\n';
    expect(await snapshotText(bytes(md), 'text/markdown', 1000)).toBe(md);
    expect(await snapshotText(bytes('plain'), 'text/plain', 1000)).toBe('plain');
  });

  test('PDF text is extracted', async () => {
    expect(await snapshotText(makePdf('Refunds take 5 days'), 'application/pdf', 1000)).toBe(
      'Refunds take 5 days',
    );
  });

  test('images have no Snapshot text', async () => {
    expect(await snapshotText(new Uint8Array([0x89]), 'image/png', 1000)).toBeNull();
  });

  test('long text is cut at the cap and marked', async () => {
    const text = await snapshotText(bytes('x'.repeat(50)), 'text/plain', 10);
    expect(text).toBe('x'.repeat(10) + TRUNCATION_MARKER);
  });

  test('unreadable content is refused', async () => {
    await expect(
      snapshotText(new Uint8Array([0xff, 0xfe, 0x00]), 'text/plain', 10),
    ).rejects.toBeInstanceOf(UnreadableContentError);
    await expect(
      snapshotText(bytes('%PDF-1.4 garbage'), 'application/pdf', 10),
    ).rejects.toBeInstanceOf(UnreadableContentError);
  });
});

describe('file types', () => {
  test('only allowed extensions map to a media type', () => {
    expect(mimeTypeForFileName('Notes.MD')).toBe('text/markdown');
    expect(mimeTypeForFileName('brief.pdf')).toBe('application/pdf');
    expect(mimeTypeForFileName('photo.jpeg')).toBe('image/jpeg');
    expect(mimeTypeForFileName('run.exe')).toBeNull();
    expect(mimeTypeForFileName('page.html')).toBeNull();
    expect(mimeTypeForFileName('image.svg')).toBeNull();
    expect(mimeTypeForFileName('noextension')).toBeNull();
    expect(mimeTypeForFileName('constructor')).toBeNull();
    expect(mimeTypeForFileName('x.constructor')).toBeNull();
  });

  test('binary types must carry their magic number', () => {
    expect(matchesMimeType(makePdf('x'), 'application/pdf')).toBe(true);
    expect(matchesMimeType(bytes('not a pdf'), 'application/pdf')).toBe(false);
    expect(matchesMimeType(bytes('GIF89a...'), 'image/gif')).toBe(true);
    expect(matchesMimeType(bytes('GIF89a...'), 'image/png')).toBe(false);
  });
});
