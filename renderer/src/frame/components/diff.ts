// <canopy-diff>: a before and after, drawn like the Changes panel's diffs (inspector.tsx CompactDiff): small mono,
// wrapped lines, tinted rows, a quiet line-number marker where it skips ahead.
// Data: two <pre> (before, then after), or one <pre> holding a unified diff. Attributes: file, split, words.
// `words` is for prose: one flowing text, what was removed struck through and what was added marked.
import { diffLines, diffWords, hunks, isUnified, parseUnified, type DiffLine } from '../diff';
import { CanopyElement, define, esc } from '../element';
import { rt } from '../runtime';

const CSS = `
:host { display: block; }
.frame { border: 1px solid var(--color-border-tertiary); border-radius: calc(var(--border-radius-md) - 2px); overflow: hidden; font: 11px/17px var(--font-mono); letter-spacing: 0; }
.file, .at { padding: 2px 10px; font: 11px/16px var(--font-sans); letter-spacing: 0.01em; }
.file { padding: 4px 10px; border-bottom: 1px solid var(--color-border-tertiary); color: var(--color-text-secondary); }
.at { background: color-mix(in oklch, var(--color-background-tertiary) 50%, transparent); color: var(--color-text-tertiary); }
.l { display: flex; gap: 8px; padding: 0 10px; }
.l.add { background: color-mix(in oklch, var(--color-text-success) 10%, transparent); }
.l.del { background: color-mix(in oklch, var(--color-text-danger) 10%, transparent); }
.s { flex: none; width: 8px; color: var(--color-text-tertiary); user-select: none; -webkit-user-select: none; }
.add .s { color: var(--color-text-success); }
.del .s { color: var(--color-text-danger); }
.t { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: color-mix(in oklch, var(--color-text-primary) 85%, transparent); user-select: text; -webkit-user-select: text; }
.add mark { background: color-mix(in oklch, var(--color-text-success) 22%, transparent); color: inherit; border-radius: 2px; }
.del mark { background: color-mix(in oklch, var(--color-text-danger) 22%, transparent); color: inherit; border-radius: 2px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; }
.cols > .side + .side { border-left: 1px solid var(--color-border-tertiary); }
.side { min-width: 0; }
.l.pad { background: color-mix(in oklch, var(--color-background-tertiary) 35%, transparent); }
.same { padding: 10px; font: 12px/16px var(--font-sans); color: var(--color-text-tertiary); }
.prose { padding: 12px 14px; font: 13px/22px var(--font-sans); letter-spacing: -0.003em; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
.prose del { padding: 1px 0; border-radius: 2px; background: color-mix(in oklch, var(--color-text-danger) 12%, transparent); color: var(--color-text-secondary); text-decoration: line-through; text-decoration-color: color-mix(in oklch, var(--color-text-danger) 60%, transparent); }
.prose ins { padding: 1px 0; border-radius: 2px; background: color-mix(in oklch, var(--color-text-success) 16%, transparent); text-decoration: none; }
.prose del + ins { margin-left: 3px; }
`;

const row = (kind: 'add' | 'del' | '', text: string, sign: string) => `<div class="l${kind ? ` ${kind}` : ''}"><span class="s">${sign}</span><span class="t">${text || ' '}</span></div>`;
const pad = '<div class="l pad"><span class="s"></span><span class="t"> </span></div>';

// A removed line directly followed by its replacement: mark only the part of each that differs.
function marked(lines: DiffLine[]): string[] {
  const out = lines.map((l) => esc(l.t));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].k !== '-') continue;
    let dels = i;
    while (dels < lines.length && lines[dels].k === '-') dels++;
    let adds = dels;
    while (adds < lines.length && lines[adds].k === '+') adds++;
    if (dels - i === adds - dels) {
      for (let k = 0; k < dels - i; k++) {
        const { pieces, same } = diffWords(lines[i + k].t, lines[dels + k].t);
        // Lines with little in common are simply different lines: marking nearly all of both says nothing.
        if (same < 0.3) continue;
        out[i + k] = pieces.filter((p) => p.k !== '+').map((p) => (p.k === '-' ? `<mark>${esc(p.t)}</mark>` : esc(p.t))).join('');
        out[dels + k] = pieces.filter((p) => p.k !== '-').map((p) => (p.k === '+' ? `<mark>${esc(p.t)}</mark>` : esc(p.t))).join('');
      }
    }
    i = adds - 1;
  }
  return out;
}

class CanopyDiff extends CanopyElement {
  constructor() { super(CSS); }

  protected render() {
    const pres = Array.from(this.querySelectorAll(':scope > pre')).map((p) => (p.textContent ?? '').replace(/^\n/, '').replace(/\n$/, ''));
    const file = this.getAttribute('file') ?? '';
    if (this.hasAttribute('words') && pres.length >= 2) {
      const { pieces } = diffWords(pres[0], pres[1]);
      const text = pieces.map((p) => (p.k === '-' ? `<del>${esc(p.t)}</del>` : p.k === '+' ? `<ins>${esc(p.t)}</ins>` : esc(p.t))).join('');
      const html = `<div class="frame">${file ? `<div class="file">${esc(file)}</div>` : ''}<div class="prose">${text}</div></div>`;
      if (this.root.innerHTML !== html) this.root.innerHTML = html;
      return;
    }
    let lines: DiffLine[];
    if (pres.length >= 2) lines = diffLines(pres[0], pres[1]);
    else if (pres.length === 1 && isUnified(pres[0])) lines = parseUnified(pres[0]);
    // One block and more may be coming: show it as it stands until the other arrives.
    else lines = (pres[0] ?? '').split('\n').filter((_, _i, all) => all.length > 1 || all[0] !== '').map((t, i) => ({ k: ' ' as const, t, a: i + 1, b: i + 1 }));
    const changed = lines.some((l) => l.k !== ' ');
    const text = marked(lines);
    const index = new Map(lines.map((l, i) => [l, i]));
    const runs = changed ? hunks(lines) : [{ at: 1, lines }];
    const split = this.hasAttribute('split');

    const body = runs.map((h, n) => {
      const at = n > 0 || h.at > 1 ? `<div class="at">Line ${h.at}</div>` : '';
      if (!split) return at + h.lines.map((l) => row(l.k === '+' ? 'add' : l.k === '-' ? 'del' : '', text[index.get(l) as number], l.k === '+' ? '+' : l.k === '-' ? '−' : '')).join('');
      // Side by side: removals on the left, additions on the right, kept lines on both, padded so they line up.
      const left: string[] = [];
      const right: string[] = [];
      const even = () => { while (left.length < right.length) left.push(pad); while (right.length < left.length) right.push(pad); };
      for (const l of h.lines) {
        const t = text[index.get(l) as number];
        if (l.k === '-') left.push(row('del', t, '−'));
        else if (l.k === '+') right.push(row('add', t, '+'));
        else { even(); left.push(row('', t, '')); right.push(row('', t, '')); }
      }
      even();
      return `${at}<div class="cols"><div class="side">${left.join('')}</div><div class="side">${right.join('')}</div></div>`;
    }).join('');
    const same = !changed && pres.length >= 2 && !rt.streaming;
    const html = `<div class="frame">${file ? `<div class="file">${esc(file)}</div>` : ''}${same ? '<div class="same">No changes</div>' : body}</div>`;
    if (this.root.innerHTML !== html) this.root.innerHTML = html;
  }
}

define('canopy-diff', CanopyDiff);
