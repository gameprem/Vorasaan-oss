// Renders what a terminal shows (an @xterm/headless buffer) as an SVG terminal window.
// A dark window with its own palette, so it reads the same on GitHub's light and dark themes.

import type { IBufferCell, Terminal } from '@xterm/headless';

const CELL_W = 8.4;
const CELL_H = 19;
const FONT_SIZE = 14;
const PAD = 18;
const TITLE_H = 34;

const BG = '#151827';
const FG = '#dfe3f0';
/** ANSI 0–15, after the ADR 0008 tokens: ink, jade, lacquer, saffron, ember. */
const PALETTE = [
  '#3a3f58',
  '#ff7a6b',
  '#4fd1a1',
  '#f2b54f',
  '#8ea2ff',
  '#d79bff',
  '#5fd3e6',
  '#c9cee0',
  '#6b7194',
  '#ff9b8f',
  '#7ce0b8',
  '#ffd27a',
  '#b3c0ff',
  '#e5b8ff',
  '#8fe4f0',
  '#ffffff',
];

/** An xterm 256-colour index as a hex colour. */
function color256(n: number): string {
  if (n < 16) return PALETTE[n] as string;
  if (n >= 232) {
    const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40).toString(16).padStart(2, '0');
  return `#${level(Math.floor(i / 36))}${level(Math.floor(i / 6) % 6)}${level(i % 6)}`;
}

function fgOf(cell: IBufferCell): string {
  if (cell.isFgRGB()) return `#${cell.getFgColor().toString(16).padStart(6, '0')}`;
  if (cell.isFgPalette()) return color256(cell.getFgColor());
  return FG;
}

function bgOf(cell: IBufferCell): string | null {
  if (cell.isBgRGB()) return `#${cell.getBgColor().toString(16).padStart(6, '0')}`;
  if (cell.isBgPalette()) return color256(cell.getBgColor());
  return null;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Run = { col: number; cells: number; text: string; fg: string; bold: boolean; dim: boolean };

/**
 * The visible screen as an SVG, trimmed to the lines in use (at least `minRows`).
 * Each run of same-styled ASCII text is stretched to its cells; any other character
 * sits in its own cell, so Thai and box-drawing characters line up like in a terminal.
 */
export function terminalSvg(term: Terminal, title: string, minRows = 0): string {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const lines: { runs: Run[]; rects: { col: number; cells: number; fill: string }[] }[] = [];

  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const runs: Run[] = [];
    const rects: { col: number; cells: number; fill: string }[] = [];
    if (line) {
      for (let x = 0; x < term.cols; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        if (width === 0) continue;
        const inverse = Boolean(cell.isInverse());
        let fg = fgOf(cell);
        let bg = bgOf(cell);
        if (inverse) [fg, bg] = [bg ?? BG, fg];
        if (bg) {
          const last = rects.at(-1);
          if (last && last.fill === bg && last.col + last.cells === x) last.cells += width;
          else rects.push({ col: x, cells: width, fill: bg });
        }
        const chars = cell.getChars() || ' ';
        const style = { fg, bold: Boolean(cell.isBold()), dim: Boolean(cell.isDim()) };
        const last = runs.at(-1);
        const plain = /^[\x20-\x7e]$/.test(chars);
        if (
          plain &&
          last &&
          /^[\x20-\x7e]+$/.test(last.text) &&
          last.col + last.cells === x &&
          last.fg === style.fg &&
          last.bold === style.bold &&
          last.dim === style.dim
        ) {
          last.text += chars;
          last.cells += width;
        } else {
          runs.push({ col: x, cells: width, text: chars, ...style });
        }
      }
    }
    // Trailing spaces draw nothing.
    while (runs.length && !runs.at(-1)?.text.trim()) runs.pop();
    lines.push({ runs: runs.filter((r) => r.text.trim()), rects });
  }

  let used = lines.length;
  while (used > minRows && !lines[used - 1]?.runs.length && !lines[used - 1]?.rects.length) used--;
  const width = Math.ceil(term.cols * CELL_W + PAD * 2);
  const height = Math.ceil(TITLE_H + used * CELL_H + PAD * 1.5);

  const body = lines.slice(0, used).flatMap((line, y) => {
    const top = TITLE_H + PAD / 2 + y * CELL_H;
    const baseline = top + CELL_H * 0.74;
    return [
      ...line.rects.map(
        (r) =>
          `<rect x="${(PAD + r.col * CELL_W).toFixed(1)}" y="${top.toFixed(1)}" width="${(r.cells * CELL_W).toFixed(1)}" height="${CELL_H}" fill="${r.fill}"/>`,
      ),
      ...line.runs.map((r) => {
        const x = (PAD + r.col * CELL_W).toFixed(1);
        const stretch =
          r.text.length > 1
            ? ` textLength="${(r.cells * CELL_W).toFixed(1)}" lengthAdjust="spacing"`
            : '';
        const weight = r.bold ? ' font-weight="700"' : '';
        const opacity = r.dim ? ' opacity="0.6"' : '';
        return `<text x="${x}" y="${baseline.toFixed(1)}" fill="${r.fg}"${weight}${opacity}${stretch} xml:space="preserve">${escapeXml(r.text)}</text>`;
      }),
    ];
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="none" stroke="#2c3150"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
<text x="${width / 2}" y="22" fill="#8a90ad" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="13" text-anchor="middle">${escapeXml(title)}</text>
<g font-family="'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Noto Sans Thai', monospace" font-size="${FONT_SIZE}">
${body.join('\n')}
</g>
</svg>
`;
}
