// "Level 1" rich replies: Claude writes plain Markdown; Canopy makes the useful bits interactive.
//  - File paths in inline code (`src/main.mjs:42`, `~/x/y`, `/tmp/a`) open on click; ⌥-click shows them in Finder.
//  - Table headers sort the table (click again to reverse, a third time to restore Claude's order).
// One document-level listener + one observer, so it covers every reply, plan card and fold without touching
// the Markdown renderer.
import { toast } from 'sonner';
import { api } from './api';
import { feature } from './telemetry';

const PATH = /^(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w.@+-]+(?::\d+(?::\d+)?)?$/;
function asPath(text: string): string | null {
  const t = text.trim();
  if (t.length < 3 || t.length > 300 || /\s/.test(t) || /^[a-z]+:\/\//i.test(t) || t.startsWith('--') || t.startsWith('@')) return null; // flags, npm scopes
  if (!PATH.test(t)) return null;
  const bare = t.replace(/:\d+(?::\d+)?$/, '');
  const hasDir = bare.includes('/');
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(bare) && !/^\d+(\.\d+)+$/.test(bare); // not a version number
  if (!hasDir && !hasExt) return null;
  if (!hasDir && /^[\w-]+\.(com|org|io|dev|ai|net|app)$/i.test(bare)) return null; // domains, not files
  if (/^\.\.?$/.test(bare)) return null;
  return bare;
}

const REPLY = '.prose-reply';
// Past this many pending roots (a burst, or a long stretch hidden with no frames) one full scan is cheaper, and
// the pending set stops holding on to nodes.
const MAX_ROOTS = 64;

// `root` is the document, a reply, or a subtree that holds replies: selectors match against the whole document,
// so the `.prose-reply` ancestor can be the root itself.
function mark(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(`${REPLY} code:not(pre code)`).forEach((el) => {
    const text = el.textContent ?? '';
    if (el.dataset.pathChecked === text) return; // re-check only if it changed (text grows while streaming)
    el.dataset.pathChecked = text;
    const p = asPath(text);
    if (!p) { delete el.dataset.path; el.removeAttribute('title'); el.removeAttribute('role'); return; }
    el.dataset.path = p;
    el.title = 'Open  ·  ⌥-click to show in Finder';
    el.setAttribute('role', 'link');
  });
  root.querySelectorAll<HTMLTableCellElement>(`${REPLY} [data-streamdown="table-header-cell"]:not([data-sortable])`).forEach((th) => {
    th.dataset.sortable = '1';
    th.title = 'Sort';
  });
}

const cellText = (row: Element, i: number) => (row.children[i]?.textContent ?? '').trim();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortBy(th: HTMLTableCellElement) {
  const table = th.closest('table');
  const body = table?.querySelector('tbody');
  if (!table || !body) return;
  const col = Array.from(th.parentElement!.children).indexOf(th);
  const rows = Array.from(body.children);
  rows.forEach((r, i) => { if (!(r as HTMLElement).dataset.order) (r as HTMLElement).dataset.order = String(i); });
  const cur = th.getAttribute('aria-sort');
  const next = cur === 'ascending' ? 'descending' : cur === 'descending' ? 'none' : 'ascending';
  table.querySelectorAll('[aria-sort]').forEach((x) => x.removeAttribute('aria-sort'));
  if (next !== 'none') th.setAttribute('aria-sort', next);
  const dir = next === 'descending' ? -1 : 1;
  rows.sort((a, b) => next === 'none'
    ? Number((a as HTMLElement).dataset.order) - Number((b as HTMLElement).dataset.order)
    : dir * collator.compare(cellText(a, col), cellText(b, col)));
  rows.forEach((r) => body.appendChild(r));
}

export function installRichReplies() {
  const w = window as unknown as { __canopyRich?: boolean };
  if (w.__canopyRich) return; // HMR / double mount
  w.__canopyRich = true;

  document.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const code = t.closest<HTMLElement>('code[data-path]');
    if (code && !window.getSelection()?.toString()) {
      e.preventDefault();
      feature(e.altKey ? 'reveal_in_finder' : 'file_opened');
      const res = await api.openPath(code.dataset.path!, null, e.altKey);
      if (!res?.ok) toast(res?.missing ? `Couldn’t find ${code.dataset.path}` : `Couldn’t open ${code.dataset.path}`);
      return;
    }
    const th = t.closest<HTMLTableCellElement>('[data-sortable]');
    if (th && !t.closest('button')) sortBy(th);
  });

  // Re-mark only what changed: the reply a mutation landed in, or a newly added subtree that holds replies (a new
  // turn, a loaded session). A streamed frame then costs one reply, not the whole transcript.
  const dirty = new Set<Element>();
  let all = false; // too many roots to track; scan the document once instead
  let queued = false;
  const run = () => {
    queued = false;
    if (all) mark(document);
    else dirty.forEach((root) => { if (root.isConnected) mark(root); });
    all = false;
    dirty.clear();
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (all) break;
      const el = r.target instanceof Element ? r.target : r.target.parentElement; // characterData targets the text node
      const reply = el?.closest(REPLY);
      if (reply) dirty.add(reply);
      else for (const n of r.addedNodes) if (n instanceof Element && (n.matches(REPLY) || n.querySelector(REPLY))) dirty.add(n);
      if (dirty.size > MAX_ROOTS) { all = true; dirty.clear(); }
    }
    if (!queued && (all || dirty.size)) { queued = true; requestAnimationFrame(run); }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  mark(document);
}
