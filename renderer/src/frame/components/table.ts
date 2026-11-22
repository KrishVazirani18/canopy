// <canopy-table>: rows of data that sort, search and fold, looking like a table in a reply.
// Data: CSV text inside the element (first line the column names), or a plain <table> whose cells keep their HTML.
// Attributes: caption, sort="Column [desc]", rows="10".
import { isNumeric, numberOf, parseCsv } from '../csv';
import { CanopyElement, define, esc } from '../element';
import { rt } from '../runtime';

const CSS = `
:host { display: block; }
.head { display: flex; align-items: center; gap: 12px; min-height: 26px; margin-bottom: 6px; }
.caption { flex: 1; min-width: 0; font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input.search { flex: none; width: 180px; height: 26px; padding: 2px 10px; border-color: var(--color-border-tertiary); font-size: 12px; }
.frame { border: 1px solid var(--color-border-secondary); border-radius: 10px; overflow: hidden; }
.scroll { overflow-x: auto; }
table { min-width: 100%; width: max-content; max-width: none; }
th, td { padding: 8px 14px; max-width: 360px; }
th:first-child, td:first-child { padding-left: 14px; }
th:last-child, td:last-child { padding-right: 14px; }
th { position: relative; background: color-mix(in oklch, var(--color-text-primary) 4%, transparent); border-bottom: 1px solid var(--color-border-secondary); user-select: none; -webkit-user-select: none; cursor: default; }
th:hover { color: var(--color-text-primary); }
/* The sort mark sits after a name, and before it on a column of numbers, so the name stays over its figures. */
th:not(.n)::after, th.n::before { content: ""; display: inline-block; width: 0.6em; opacity: 0; }
th:not(.n)::after { margin-left: 6px; }
th.n::before { margin-right: 6px; }
th:not(.n):hover::after, th.n:hover::before { content: "↕"; opacity: 0.4; }
th[aria-sort="ascending"]:not(.n)::after, th.n[aria-sort="ascending"]::before { content: "↑"; opacity: 0.8; }
th[aria-sort="descending"]:not(.n)::after, th.n[aria-sort="descending"]::before { content: "↓"; opacity: 0.8; }
th.n, td.n { text-align: right; }
td { overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
tbody tr { transition: background-color 80ms; }
tbody tr:hover { background: color-mix(in oklch, var(--color-text-primary) 2.5%, transparent); }
.more { display: flex; width: 100%; height: 32px; border: 0; border-top: 1px solid var(--color-border-tertiary); border-radius: 0; font-size: 12px; font-weight: 400; color: var(--color-text-secondary); }
.more:hover { color: var(--color-text-primary); }
.none { padding: 14px; font-size: 12px; color: var(--color-text-tertiary); }
`;

type State = { col?: number; dir?: 1 | -1; all?: boolean; q?: string };
type Row = { cells: string[]; html?: string[] };

class CanopyTable extends CanopyElement {
  private state: State | null = null;
  private drawn = '';
  constructor() { super(CSS); }

  // The data as Claude wrote it: column names, then rows.
  private read(): { head: string[]; rows: Row[] } {
    const table = this.querySelector('table');
    if (table) {
      const trs = Array.from(table.querySelectorAll('tr'));
      const cellsOf = (tr: Element) => Array.from(tr.children).filter((c) => c.localName === 'td' || c.localName === 'th');
      const first = trs[0] ? cellsOf(trs[0]) : [];
      return {
        head: first.map((c) => c.textContent?.trim() ?? ''),
        rows: trs.slice(1).map((tr) => { const cs = cellsOf(tr); return { cells: cs.map((c) => c.textContent?.trim() ?? ''), html: cs.map((c) => c.innerHTML) }; }),
      };
    }
    const data = parseCsv(this.textContent ?? '', rt.streaming);
    return { head: data[0] ?? [], rows: data.slice(1).map((cells) => ({ cells })) };
  }

  protected render() {
    const { head, rows } = this.read();
    if (!this.state) {
      this.state = this.recall<State>() ?? {};
      // sort="Cost desc": the order Claude asked it to start in.
      const m = /^(.*?)(?:\s+(asc|desc))?$/i.exec(this.getAttribute('sort')?.trim() ?? '');
      const col = m?.[1] ? head.findIndex((h) => h.toLowerCase() === m[1].trim().toLowerCase()) : -1;
      if (this.state.col === undefined && col >= 0) { this.state.col = col; this.state.dir = m?.[2]?.toLowerCase() === 'desc' ? -1 : 1; }
      else if (col < 0 && this.hasAttribute('sort') && rt.streaming) this.state = null; // the column's name has not arrived yet
    }
    const st = this.state ?? {};
    const numeric = head.map((_, i) => isNumeric(rows.map((r) => r.cells[i] ?? '')));
    // A count written bare ("1830400") is given its separators. Not in a column that names things by number.
    const counts = head.map((h, i) => numeric[i] && !/\b(id|year|zip|port|code|pid|no|number|phone|line|#)\b/i.test(h));
    const shownCell = (text: string, i: number) => (counts[i] && /^-?\d{5,}$/.test(text) ? Number(text).toLocaleString('en-US') : text);
    const limit = Math.max(1, Number(this.getAttribute('rows')) || 10);
    const q = (st.q ?? '').trim().toLowerCase();

    let shown = q ? rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q))) : rows.slice();
    if (st.col !== undefined && st.col < head.length) {
      const c = st.col;
      const dir = st.dir ?? 1;
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      shown = shown.map((r, i) => ({ r, i })).sort((a, b) => {
        const x = a.r.cells[c] ?? '';
        const y = b.r.cells[c] ?? '';
        // Empty cells go last whichever way it is sorted.
        if (!x.trim() || !y.trim()) return (x.trim() ? 0 : 1) - (y.trim() ? 0 : 1) || a.i - b.i;
        const d = numeric[c] ? (numberOf(x) ?? 0) - (numberOf(y) ?? 0) : collator.compare(x, y);
        return d * dir || a.i - b.i;
      }).map((x) => x.r);
    }
    const total = shown.length;
    const folded = !st.all && !q && total > limit + 2; // never fold away just a row or two
    if (folded) shown = shown.slice(0, limit);

    const caption = this.getAttribute('caption') ?? '';
    const search = rows.length > 10;
    const body = shown.map((r) => `<tr>${head.map((_, i) => `<td${numeric[i] ? ' class="n"' : ''}>${r.html ? r.html[i] ?? '' : esc(shownCell(r.cells[i] ?? '', i))}</td>`).join('')}</tr>`).join('');
    const html = `
      ${caption || search ? `<div class="head"><span class="caption">${esc(caption)}</span>${search ? '<input class="search" type="search" placeholder="Search" aria-label="Search">' : ''}</div>` : ''}
      <div class="frame"><div class="scroll"><table>
        <thead><tr>${head.map((h, i) => `<th scope="col" data-i="${i}"${numeric[i] ? ' class="n"' : ''}${st.col === i ? ` aria-sort="${(st.dir ?? 1) > 0 ? 'ascending' : 'descending'}"` : ''}>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      ${!rows.length && !rt.streaming ? '<div class="none">No rows</div>' : q && !total ? '<div class="none">No matches</div>' : ''}
      ${folded ? `<button class="more" type="button" data-all="1">Show all ${total.toLocaleString('en-US')} rows</button>` : st.all && total > limit + 2 ? '<button class="more" type="button" data-all="0">Show fewer</button>' : ''}
      </div>`;
    if (html === this.drawn) return;
    this.drawn = html;
    // Redrawing must not take the search box out from under the cursor.
    const box = this.root.querySelector<HTMLInputElement>('.search');
    const typing = box && this.root.activeElement === box ? [box.selectionStart, box.selectionEnd] as const : null;
    this.root.innerHTML = html;
    const next = this.root.querySelector<HTMLInputElement>('.search');
    if (next) {
      next.value = st.q ?? '';
      if (typing) { next.focus(); next.setSelectionRange(typing[0], typing[1]); }
      next.addEventListener('input', () => this.update({ q: next.value }));
    }
    this.root.querySelector('thead')?.addEventListener('click', (e) => {
      const th = (e.target as Element).closest('th');
      if (!th) return;
      const i = Number(th.getAttribute('data-i'));
      // Like a table in a reply: up, down, then back to the order it came in. Numbers start largest first.
      const first = numeric[i] ? -1 : 1;
      if (st.col !== i) this.update({ col: i, dir: first });
      else if (st.dir === first) this.update({ dir: -first as 1 | -1 });
      else this.update({ col: undefined, dir: undefined });
    });
    this.root.querySelector('.more')?.addEventListener('click', (e) => this.update({ all: (e.currentTarget as Element).getAttribute('data-all') === '1' }));
  }

  private update(patch: State) {
    this.state = { ...(this.state ?? {}), ...patch };
    const { q, ...kept } = this.state; // what was typed in the search box is not worth remembering
    void q;
    this.remember(kept);
    this.changed();
  }
}

define('canopy-table', CanopyTable);
