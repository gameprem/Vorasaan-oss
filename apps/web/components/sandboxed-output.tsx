'use client';

import { useEffect, useState } from 'react';
import { buttonClass } from './ui/button';

// What the AI makes with an Agent Skill (ADR 0017, ticket 0078), such as a diagram, arrives as
// a fenced ```svg or ```html block. It is untrusted markup, so it is never put in the page: it
// is shown in an iframe sandboxed to nothing (no scripts, no forms, no navigation, its own
// opaque origin) whose document also carries a Content Security Policy that allows no script
// and no network (images and fonts only as data: URLs, styles inline). It can be downloaded.

export type SandboxedKind = 'svg' | 'html';

/**
 * The iframe's document: the markup inside a page whose CSP blocks scripts, every fetch,
 * forms and `<base>`. The sandbox attribute already blocks scripts; the CSP also blocks loads.
 */
export const SANDBOX_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

export function sandboxDocument(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;background:#fff;color:#0f172a;font-family:system-ui,sans-serif}body{padding:8px;box-sizing:border-box}svg{display:block;max-width:100%;height:auto;margin:0 auto}</style></head><body>${source}</body></html>`;
}

/** The width-to-height ratio of an SVG from its viewBox, kept within sensible bounds. */
function aspectOf(source: string): number | null {
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(
    source,
  );
  const width = Number(box?.[1]);
  const height = Number(box?.[2]);
  if (!width || !height) return null;
  return Math.min(6, Math.max(0.5, width / height));
}

export function SandboxedOutput({ kind, source }: { kind: SandboxedKind; source: string }) {
  const [href, setHref] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([source], { type: kind === 'svg' ? 'image/svg+xml' : 'text/html' }),
    );
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [kind, source]);
  const aspect = kind === 'svg' ? aspectOf(source) : null;
  const name = kind === 'svg' ? 'Diagram' : 'HTML';

  return (
    <figure className="my-3 overflow-hidden rounded-card bg-rail" data-sandboxed-output={kind}>
      <iframe
        title={`${name} made by the AI (sandboxed: no scripts, no network)`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={sandboxDocument(source)}
        className="block w-full border-0 bg-white"
        style={aspect ? { aspectRatio: `${aspect}`, maxHeight: 560 } : { height: 400 }}
      />
      <figcaption className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm text-fg-soft">
        <span>
          {name} made by the AI, shown sandboxed. It is a draft until a person approves it.
        </span>
        <a
          href={href}
          download={kind === 'svg' ? 'diagram.svg' : 'page.html'}
          className={buttonClass('secondary', 'sm')}
          aria-disabled={href ? undefined : true}
        >
          Download {kind === 'svg' ? 'SVG' : 'HTML'}
        </a>
        <details className="w-full">
          <summary className="cursor-pointer">Source</summary>
          <SourceRegion label={`${name} source`}>{source}</SourceRegion>
        </details>
      </figcaption>
    </figure>
  );
}

/** The markup as text, in a region that scrolls on its own and is reachable by keyboard. */
function SourceRegion({ label, children }: { label: string; children: string }) {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
      tabIndex={0}
      className="mt-2 max-h-64 overflow-auto rounded-tile bg-bg"
    >
      <pre className="p-2 font-mono text-xs text-fg">{children}</pre>
    </section>
  );
}
