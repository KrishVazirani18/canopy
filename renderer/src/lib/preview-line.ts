// The sidebar's second line is one line of a reply. Main strips its markdown (previewOf in src/last-active.mjs), but
// lines saved before that, or written by another app, can still carry "### " or "**[the report](https://…" — and math
// arrives as \( … \). This turns the line into plain words and math pieces, which the row draws with KaTeX.
// Plain TypeScript with no run-time imports, so node's tests run it as it is.

export type PreviewPart = { text: string } | { tex: string };

const MATH = /\$\$([^$]+?)\$\$|\\\((.+?)\\\)|\\\[(.+?)\\\]/g;

/** Markdown marks off one line: heading and list markers, bold, code ticks, and links (even one cut off mid-address). */
function plain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\((?:[^)]*\)|[^)]*$)/g, '$1')
    .replace(/\*\*|__|`/g, '');
}

export function previewParts(line: string): PreviewPart[] {
  const s = line.replace(/^\s*(?:#+\s+|[-*>]\s+|\d+\.\s+)/, '');
  const parts: PreviewPart[] = [];
  let at = 0;
  for (const m of s.matchAll(MATH)) {
    const tex = (m[1] ?? m[2] ?? m[3]).trim();
    if (!tex) continue;
    if (m.index > at) parts.push({ text: plain(s.slice(at, m.index)) });
    parts.push({ tex });
    at = m.index + m[0].length;
  }
  if (at < s.length) parts.push({ text: plain(s.slice(at)) });
  return parts.filter((p) => !('text' in p) || p.text);
}
