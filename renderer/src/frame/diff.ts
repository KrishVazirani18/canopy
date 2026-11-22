// What changed between two texts, line by line, for <canopy-diff>. Plain text work, tested in node
// (src/core/test/unit/frame.test.mjs), so erasable syntax only.

export type DiffLine = { k: '+' | '-' | ' '; t: string; /** Line numbers in the old and the new text (1-based). */ a?: number; b?: number };
const MAX_CELLS = 2_000_000; // of the comparison table: beyond this the two texts are shown as all-old, all-new

/** The lines of `before` and `after` as kept, removed and added, in reading order (removals before additions). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.replace(/\r\n?/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n?/g, '\n').split('\n');
  // What the two share at both ends needs no comparing.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ k: ' ', t: a[i], a: i + 1, b: i + 1 });
  if (n * m > MAX_CELLS) {
    for (let i = 0; i < n; i++) out.push({ k: '-', t: a[head + i], a: head + i + 1 });
    for (let j = 0; j < m; j++) out.push({ k: '+', t: b[head + j], b: head + j + 1 });
  } else {
    // Longest common subsequence, filled from the end so the walk below reads forward.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    const added: DiffLine[] = [];
    const flush = () => { out.push(...added.splice(0)); };
    while (i < n || j < m) {
      if (i < n && j < m && a[head + i] === b[head + j]) { flush(); out.push({ k: ' ', t: a[head + i], a: head + i + 1, b: head + j + 1 }); i++; j++; }
      else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { out.push({ k: '-', t: a[head + i], a: head + i + 1 }); i++; }
      else { added.push({ k: '+', t: b[head + j], b: head + j + 1 }); j++; }
    }
    flush();
  }
  for (let i = 0; i < tail; i++) out.push({ k: ' ', t: a[a.length - tail + i], a: a.length - tail + i + 1, b: b.length - tail + i + 1 });
  return out;
}

/** True when the text reads as a unified diff: every line is an addition, a removal, context, or a diff header. */
export function isUnified(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l !== '');
  if (lines.length < 2 || !lines.some((l) => /^[+-](?![+-]{2} )/.test(l))) return false;
  return lines.every((l) => /^(?:[ +-]|@@|diff |index |\\ )/.test(l));
}

/** A unified diff's own lines, without its headers. */
export function parseUnified(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  for (const l of text.replace(/\r\n?/g, '\n').split('\n')) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (at) { a = Number(at[1]) - 1; b = Number(at[2]) - 1; continue; }
    if (/^(?:diff |index |--- |\+\+\+ |\\ )/.test(l) || (l === '' && !out.length)) continue;
    if (l[0] === '+') out.push({ k: '+', t: l.slice(1), b: ++b });
    else if (l[0] === '-') out.push({ k: '-', t: l.slice(1), a: ++a });
    else out.push({ k: ' ', t: l.slice(1), a: ++a, b: ++b });
  }
  while (out.length && out[out.length - 1].k === ' ' && out[out.length - 1].t === '') out.pop();
  return out;
}

export type Hunk = { /** The new text's line number where this run starts. */ at: number; lines: DiffLine[] };

/** The changes with `context` unchanged lines around each, as runs; what lies between runs is left out. */
export function hunks(lines: DiffLine[], context = 3): Hunk[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => { if (l.k !== ' ') for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1; });
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  lines.forEach((l, i) => {
    if (!keep[i]) { cur = null; return; }
    if (!cur) { cur = { at: l.b ?? l.a ?? 1, lines: [] }; out.push(cur); }
    cur.lines.push(l);
  });
  return out;
}

export type Piece = { k: '+' | '-' | ' '; t: string };
const WORD = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu;

/**
 * What changed between two pieces of prose, word by word: runs of text that stayed, were removed, were added.
 * A reworded stretch comes out as one removal then one addition (not word, word, word, word), so it reads as
 * "this became that". `same` is how much of the longer text survived, 0 to 1.
 */
export function diffWords(before: string, after: string): { pieces: Piece[]; same: number } {
  const a = before.match(WORD) ?? [];
  const b = after.match(WORD) ?? [];
  if (a.length * b.length > MAX_CELLS) return { pieces: [{ k: '-', t: before }, { k: '+', t: after }], same: 0 };
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  }
  const ops: Piece[] = [];
  let i = 0;
  let j = 0;
  let kept = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ k: ' ', t: a[i] }); if (a[i].trim()) kept++; i++; j++; }
    else if (i < a.length && (j >= b.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) ops.push({ k: '-', t: a[i++] });
    else ops.push({ k: '+', t: b[j++] });
  }
  // A space that stayed between two changed words belongs to the change on both sides of it.
  const pieces: Piece[] = [];
  for (let n = 0; n < ops.length;) {
    if (ops[n].k === ' ') { const last = pieces[pieces.length - 1]; if (last?.k === ' ') last.t += ops[n].t; else pieces.push({ ...ops[n] }); n++; continue; }
    let gone = '';
    let came = '';
    let end = n;
    for (let m = n; m < ops.length; m++) {
      const op = ops[m];
      if (op.k === ' ') { if (op.t.trim() || !ops.slice(m + 1).some((x, d) => x.k !== ' ' && d < 1)) break; continue; }
      end = m;
    }
    for (let m = n; m <= end; m++) { const op = ops[m]; if (op.k !== '+') gone += op.t; if (op.k !== '-') came += op.t; }
    if (gone) pieces.push({ k: '-', t: gone });
    if (came) pieces.push({ k: '+', t: came });
    n = end + 1;
  }
  const words = Math.max(a.filter((t) => t.trim()).length, b.filter((t) => t.trim()).length);
  return { pieces, same: words ? kept / words : 1 };
}
