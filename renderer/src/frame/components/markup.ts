// <canopy-markup>: notes pinned on a design. Wraps anything (a mockup, a <canopy-scale>, a <canopy-shot>). A click
// drops a numbered pin, a drag draws a box; each gets a note in the list beside the design (below it when narrow).
// Sending writes one message that names what is under every note, so the model knows where each applies:
//   Notes on the landing page:
//   1. "Calm software for people who build…" (h1): one line too long
//   2. Box around "Download for Mac Watch the tour" (div): too close together
// Inside the frame that is the element under the pin (document.elementFromPoint); on a screenshot it is the shot's
// element map. With a screenshot the message also carries the picture with the pins and boxes drawn on it.
// <canopy-review ref="look-3"> is the same around <canopy-shot ref="look-3">.
// Attributes: title (what the notes are on), message ("{notes}" is not needed: the notes always follow), button.
// Keyboard: Enter on the design drops a pin in its middle; on a pin, arrows move it, Delete removes it.
import { CanopyElement, define, esc } from '../element';
import { rt, type Shot, type ShotImage } from '../runtime';
import { boxSubject, elementAt, inBox, noteSubject, unit, whereOn, type Described } from '../marks';
import { markupMessage } from '../words';
import { CONFIRM_CSS, confirmRow, updateConfirm } from './confirm';
import type { ShotElement } from './shot';

const CSS = `
:host { display: block; min-width: 0; container-type: inline-size; }
.wrap { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
@container (min-width: 600px) { .wrap { grid-template-columns: minmax(0, 1fr) 232px; } }
.stage { position: relative; min-width: 0; }
.layer { position: absolute; inset: 0; z-index: 3; cursor: crosshair; outline: none; touch-action: none; user-select: none; -webkit-user-select: none; }
.layer:focus-visible { outline: 1.5px solid var(--color-ring-primary); outline-offset: 2px; border-radius: var(--border-radius-lg); }
:host([data-locked]) .layer, :host([data-streaming]) .layer { cursor: default; }
:host([data-noshot]) .layer { display: none; }
.pin, .box .n { position: absolute; display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; background: var(--color-text-primary); color: var(--color-background-primary); font: 600 11px/1 var(--font-sans); font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px var(--color-background-primary), 0 2px 8px rgb(0 0 0 / 0.28); cursor: default; }
.pin { transform: translate(-50%, -50%); }
.pin:hover, .box .n:hover { background: var(--color-text-primary); opacity: 1; transform: translate(-50%, -50%) scale(1.06); }
.pin:active { transform: translate(-50%, -50%); }
.box { position: absolute; border: 2px solid var(--color-text-primary); border-radius: 4px; box-shadow: 0 0 0 1px var(--color-background-primary), inset 0 0 0 1px var(--color-background-primary); pointer-events: none; }
.box .n { top: 0; left: 0; transform: translate(-50%, -50%); pointer-events: auto; }
.draft { position: absolute; border: 1.5px dashed var(--color-text-primary); border-radius: 4px; background: color-mix(in oklch, var(--color-text-primary) 6%, transparent); pointer-events: none; }
.draft[hidden] { display: none; }
.mark-new { animation: drop 180ms cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes drop { from { opacity: 0; scale: 0.6; } to { opacity: 1; scale: 1; } }
.side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.hint { font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-secondary); }
:host([data-locked]) .hint { display: none; }
.notes { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.notes li { display: grid; grid-template-columns: 20px minmax(0, 1fr) 20px; gap: 8px; margin: 0; align-items: start; }
.notes .n { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; margin-top: 2px; border-radius: 50%; background: var(--color-text-primary); color: var(--color-background-primary); font: 600 10px/1 var(--font-sans); font-variant-numeric: tabular-nums; }
.what { overflow: hidden; margin-bottom: 4px; font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.notes textarea { display: block; min-height: 0; height: 52px; padding: 6px 10px; font-size: 12px; line-height: 16px; resize: none; }
:host([data-locked]) .notes textarea { border-color: transparent; padding-left: 0; padding-right: 0; height: auto; color: var(--color-text-primary); opacity: 1; }
.rm { width: 20px; height: 20px; margin-top: 2px; padding: 0; border: 0; border-radius: var(--border-radius-sm); color: var(--color-text-tertiary); font-weight: 400; }
.rm:hover { color: var(--color-text-primary); }
.rm svg { width: 10px; height: 10px; }
:host([data-locked]) .rm { visibility: hidden; }
${CONFIRM_CSS}
`;

const X = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"/></svg>';
const MAX_MARKS = 24;
const MAX_NOTE = 600;
const MAX_IMAGE = 4.8 * 1024 * 1024; // bytes; the host takes at most 5 MB a picture

type Mark = { id: number; kind: 'pin' | 'box'; x: number; y: number; w?: number; h?: number; note: string; what?: string };
type State = { marks?: Mark[]; next?: number; sent?: boolean };

/** An element of the frame described by what it shows: its words (or alt, or label), its role or tag. */
function describeDom(el: Element): Described {
  const h = el as HTMLElement;
  const text = (h.innerText ?? '').trim() || el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  return { tag: el.localName, role: el.getAttribute('role'), text };
}

/** The picture with the notes drawn on it, as PNG (JPEG, then smaller, if that is too big to send). */
async function annotate(s: Shot, marks: Mark[]): Promise<ShotImage | null> {
  const img = new Image();
  img.src = s.data;
  try { await img.decode(); } catch { return null; }
  let fit = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  for (let attempt = 0; attempt < 5; attempt++) {
    const W = Math.max(1, Math.round(img.naturalWidth * fit));
    const H = Math.max(1, Math.round(img.naturalHeight * fit));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, W, H);
    const u = Math.max(1, Math.max(W, H) / 1200);
    const RED = '#ff3b30';
    const badge = (x: number, y: number, n: number) => {
      const r = 12 * u;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = RED; ctx.fill();
      ctx.lineWidth = 2.5 * u; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.font = `600 ${Math.round(13 * u)}px "Geist", -apple-system, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), x, y + 0.5 * u);
    };
    marks.forEach((m, i) => {
      if (m.kind === 'box') {
        ctx.lineWidth = 3 * u; ctx.strokeStyle = RED;
        ctx.strokeRect(m.x * W, m.y * H, (m.w ?? 0) * W, (m.h ?? 0) * H);
        badge(m.x * W, m.y * H, i + 1);
      } else badge(m.x * W, m.y * H, i + 1);
    });
    for (const [type, q] of [['image/png', undefined], ['image/jpeg', 0.86]] as const) {
      const url = canvas.toDataURL(type, q);
      const data = url.slice(url.indexOf(',') + 1);
      if (data.length * 0.75 <= MAX_IMAGE && url.startsWith(`data:${type};`)) return { data, mimeType: type };
    }
    fit *= 0.7;
  }
  return null;
}

export class CanopyMarkup extends CanopyElement {
  protected review = false;
  private state: State | null = null;
  private sending = false;
  private drawn = '';
  private fresh = -1; // the mark just made: its note gets the focus
  constructor() { super(CSS); }

  private get locked() { return !!this.state?.sent; }
  private get self(): Element { return this; }
  private marks(): Mark[] { return this.state?.marks ?? []; }

  /** The screenshot this markup is on, if it is on one. */
  private shotEl(): ShotElement | null {
    const own = this.root.querySelector<ShotElement>('canopy-shot');
    if (own) return own;
    return Array.from(this.querySelectorAll<ShotElement>('canopy-shot')).find((s) => s.closest('canopy-markup, canopy-review') === this) ?? null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('canopy-shot', () => this.sync());
  }

  private save(next: State) {
    this.state = next;
    this.remember(next);
    this.sync();
  }

  protected render() {
    this.state ??= this.recall<State>() ?? {};
    const ref = (this.getAttribute('ref') ?? '').trim();
    const content = this.review ? `<canopy-shot ref="${esc(ref)}" alt="${esc(this.getAttribute('alt') ?? '')}"></canopy-shot>` : '<slot></slot>';
    const html = `<div class="wrap"><div class="stage" part="stage"><div class="content">${content}</div>`
      + '<div class="layer" tabindex="0" role="group" aria-label="The design: click to pin a note, drag to draw a box, or press Enter to pin one in the middle"><div class="draft" hidden></div></div></div>'
      + '<div class="side" part="notes"><div class="hint">Click the design to pin a note there. Drag to draw a box.</div><ol class="notes"></ol></div></div>'
      + confirmRow();
    if (this.drawn !== html) {
      this.drawn = html;
      this.root.innerHTML = html;
      this.wire();
    }
    this.sync();
  }

  private wire() {
    const layer = this.root.querySelector<HTMLElement>('.layer');
    const draft = this.root.querySelector<HTMLElement>('.draft');
    if (!layer || !draft) return;
    this.root.querySelector('button.send')?.addEventListener('click', () => { void this.confirm(); });

    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.locked || rt.streaming) return;
      const hit = (e.composedPath()[0] as Element | undefined)?.closest?.('[data-id]');
      if (hit) { e.preventDefault(); this.focusNote(Number(hit.getAttribute('data-id'))); return; }
      e.preventDefault();
      layer.focus({ preventScroll: true });
      layer.setPointerCapture(e.pointerId);
      const r = layer.getBoundingClientRect();
      const fx = (x: number) => unit((x - r.left) / r.width);
      const fy = (y: number) => unit((y - r.top) / r.height);
      const x0 = fx(e.clientX);
      const y0 = fy(e.clientY);
      const start = { x: e.clientX, y: e.clientY };
      let box = false;
      let rect = { x: x0, y: y0, w: 0, h: 0 };
      const mv = (ev: PointerEvent) => {
        if (!box && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        box = true;
        const x1 = fx(ev.clientX);
        const y1 = fy(ev.clientY);
        rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        Object.assign(draft.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
        draft.hidden = false;
      };
      const up = (ev: PointerEvent) => {
        layer.removeEventListener('pointermove', mv);
        layer.removeEventListener('pointerup', up);
        layer.removeEventListener('pointercancel', cancel);
        draft.hidden = true;
        if (ev.type === 'pointercancel') return;
        if (box && rect.w * r.width >= 8 && rect.h * r.height >= 8) this.add({ kind: 'box', x: unit(rect.x), y: unit(rect.y), w: unit(rect.w), h: unit(rect.h) });
        else if (!box) this.add({ kind: 'pin', x: x0, y: y0 });
      };
      const cancel = (ev: PointerEvent) => up(ev);
      layer.addEventListener('pointermove', mv);
      layer.addEventListener('pointerup', up);
      layer.addEventListener('pointercancel', cancel);
    });

    layer.addEventListener('keydown', (e) => {
      if (this.locked || rt.streaming) return;
      const target = e.composedPath()[0] as Element | undefined;
      const id = Number(target?.closest?.('[data-id]')?.getAttribute('data-id') ?? NaN);
      if (Number.isFinite(id)) {
        const m = this.marks().find((x) => x.id === id);
        if (!m) return;
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.removeMark(id); layer.focus(); return; }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.focusNote(id); return; }
        const by = e.shiftKey ? 0.05 : 0.01;
        const dx = e.key === 'ArrowLeft' ? -by : e.key === 'ArrowRight' ? by : 0;
        const dy = e.key === 'ArrowUp' ? -by : e.key === 'ArrowDown' ? by : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        const moved = { ...m, x: unit(m.x + dx), y: unit(m.y + dy) };
        moved.what = this.describe(moved);
        this.save({ ...this.state, marks: this.marks().map((x) => (x.id === id ? moved : x)) });
        return;
      }
      if (target === layer && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.add({ kind: 'pin', x: 0.5, y: 0.5 }); }
    });

    const list = this.root.querySelector<HTMLElement>('.notes');
    list?.addEventListener('input', (e) => {
      const ta = e.target as HTMLTextAreaElement;
      const id = Number(ta.closest('li')?.getAttribute('data-id'));
      const note = ta.value.slice(0, MAX_NOTE);
      this.state = { ...this.state, marks: this.marks().map((m) => (m.id === id ? { ...m, note } : m)) };
      this.remember(this.state);
      this.updateButton();
    });
    list?.addEventListener('click', (e) => {
      const rm = (e.target as Element).closest('.rm');
      if (!rm || this.locked) return;
      this.removeMark(Number(rm.closest('li')?.getAttribute('data-id')));
    });
    list?.addEventListener('keydown', (e) => {
      // Cmd/Ctrl+Enter in a note sends, as it does in the message box.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.confirm(); }
    });
  }

  private add(m: Omit<Mark, 'id' | 'note'>) {
    const marks = this.marks();
    if (marks.length >= MAX_MARKS) return;
    const id = this.state?.next ?? (marks.reduce((n, x) => Math.max(n, x.id), 0) + 1);
    const mark: Mark = { id, note: '', ...m };
    mark.what = this.describe(mark);
    this.fresh = id;
    this.save({ ...this.state, marks: [...marks, mark], next: id + 1 });
  }

  private removeMark(id: number) {
    this.save({ ...this.state, marks: this.marks().filter((m) => m.id !== id) });
  }

  private focusNote(id: number) {
    this.root.querySelector<HTMLTextAreaElement>(`li[data-id="${id}"] textarea`)?.focus();
  }

  /** What is under a mark, in words; '' while the screenshot it is on has not arrived. */
  private describe(m: Mark): string {
    const shotEl = this.shotEl();
    if (shotEl) {
      const s = shotEl.shot;
      if (!s) return '';
      const map = (s.elements ?? []).filter((e) => !(e.w * e.h >= s.width * s.height * 0.5)); // the page itself names nothing
      if (m.kind === 'box') {
        const box = { x: m.x * s.width, y: m.y * s.height, w: (m.w ?? 0) * s.width, h: (m.h ?? 0) * s.height };
        const around = inBox(map, box);
        if (around.length) return boxSubject(around);
        const mid = elementAt(map, box.x + box.w / 2, box.y + box.h / 2);
        return mid ? noteSubject('box', mid) : this.fallback(m);
      }
      const el = elementAt(map, m.x * s.width, m.y * s.height);
      return el ? noteSubject('pin', el) : this.fallback(m);
    }
    const layer = this.root.querySelector<HTMLElement>('.layer');
    if (!layer) return this.fallback(m);
    const r = layer.getBoundingClientRect();
    const big = (e: Element) => { const b = e.getBoundingClientRect(); return b.width * b.height >= r.width * r.height * 0.5; };
    if (m.kind === 'box') {
      // What the box holds: the elements of the design (nearly) all inside it, the outermost of them.
      const box = { x: r.left + m.x * r.width, y: r.top + m.y * r.height, w: (m.w ?? 0) * r.width, h: (m.h ?? 0) * r.height };
      const all = Array.from(this.querySelectorAll('*')).filter((e) => !e.localName.startsWith('canopy-') && !['style', 'script', 'template'].includes(e.localName));
      const rects = all.map((e) => { const b = e.getBoundingClientRect(); return { el: e, x: b.left, y: b.top, w: b.width, h: b.height, ...describeDom(e) }; });
      const around = inBox(rects, box, (o, i) => o.el.contains(i.el));
      if (around.length) return boxSubject(around);
    }
    const cx = r.left + (m.x + (m.kind === 'box' ? (m.w ?? 0) / 2 : 0)) * r.width;
    const cy = r.top + (m.y + (m.kind === 'box' ? (m.h ?? 0) / 2 : 0)) * r.height;
    // Look under the layer the pins live on.
    layer.style.visibility = 'hidden';
    let el: Element | null = null;
    try { el = document.elementFromPoint(cx, cy); } finally { layer.style.visibility = ''; }
    if (!el || el === this.self || !this.contains(el) || el.localName.startsWith('canopy-') || big(el)) return this.fallback(m);
    const d = describeDom(el);
    return d.text?.trim() || d.role ? noteSubject(m.kind, d) : this.fallback(m);
  }

  private fallback(m: Mark) {
    const where = whereOn(m.x + (m.w ?? 0) / 2, m.y + (m.h ?? 0) / 2);
    return m.kind === 'box' ? `Box at the ${where} of the design` : `The ${where} of the design`;
  }

  private subject(): string {
    const own = this.getAttribute('title') || this.getAttribute('label');
    if (own) return own;
    const url = this.shotEl()?.shot?.url;
    if (url) return url;
    return rt.title;
  }

  private async confirm() {
    if (this.locked || this.sending || rt.streaming) return;
    const kept = this.marks().filter((m) => m.note.trim()).map((m) => ({ ...m, what: m.what || this.describe(m) }));
    if (!kept.length) return;
    const text = markupMessage(this.subject(), kept.map((m) => ({ what: m.what || this.fallback(m), note: m.note })));
    this.sending = true;
    const s = this.shotEl()?.shot;
    const images: ShotImage[] = [];
    if (s) { const im = await annotate(s, kept); if (im) images.push(im); }
    const ok = await rt.send(text, images);
    this.sending = false;
    if (!ok) return;
    // What was sent is what stays: notes left empty go, and the numbers match the message.
    this.save({ ...this.state, marks: kept, sent: true });
  }

  private updateButton() {
    const n = this.marks().filter((m) => m.note.trim()).length;
    updateConfirm(this.root, this.getAttribute('button') || (n ? `Send ${n} note${n === 1 ? '' : 's'}` : 'Send notes'), n > 0 && !this.locked && !rt.streaming);
  }

  /** Make the pins, boxes and notes match the state, keeping every element that is still there (and its focus). */
  private sync() {
    const layer = this.root.querySelector<HTMLElement>('.layer');
    const list = this.root.querySelector<HTMLElement>('.notes');
    if (!layer || !list) return;
    const locked = this.locked;
    this.toggleAttribute('data-locked', locked);
    this.toggleAttribute('data-streaming', rt.streaming);
    const shotEl = this.shotEl();
    this.toggleAttribute('data-noshot', !!shotEl && !shotEl.shot);
    const marks = this.marks();
    const ids = new Set(marks.map((m) => String(m.id)));
    for (const el of Array.from(layer.querySelectorAll('[data-id]'))) if (!ids.has(el.getAttribute('data-id') ?? '')) el.remove();
    for (const el of Array.from(list.querySelectorAll('li[data-id]'))) if (!ids.has(el.getAttribute('data-id') ?? '')) el.remove();
    const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    marks.forEach((m, i) => {
      const n = String(i + 1);
      // On the design.
      let mk = layer.querySelector<HTMLElement>(`[data-id="${m.id}"]`);
      if (mk && mk.getAttribute('data-kind') !== m.kind) { mk.remove(); mk = null; }
      if (!mk) {
        mk = document.createElement(m.kind === 'pin' ? 'button' : 'div');
        mk.setAttribute('data-id', String(m.id));
        mk.setAttribute('data-kind', m.kind);
        if (m.kind === 'pin') { mk.className = 'pin'; (mk as HTMLButtonElement).type = 'button'; }
        else { mk.className = 'box'; const b = document.createElement('button'); b.type = 'button'; b.className = 'n'; mk.append(b); }
        if (motion && m.id === this.fresh) mk.classList.add('mark-new');
        layer.append(mk);
      }
      const badge = m.kind === 'pin' ? mk : mk.querySelector<HTMLElement>('.n');
      if (badge && badge.textContent !== n) badge.textContent = n;
      badge?.setAttribute('aria-label', `Note ${n}${m.what ? `: ${m.what}` : ''}`);
      Object.assign(mk.style, { left: `${m.x * 100}%`, top: `${m.y * 100}%`, ...(m.kind === 'box' ? { width: `${(m.w ?? 0) * 100}%`, height: `${(m.h ?? 0) * 100}%` } : {}) });
      // In the list.
      let li = list.querySelector<HTMLLIElement>(`li[data-id="${m.id}"]`);
      if (!li) {
        li = document.createElement('li');
        li.setAttribute('data-id', String(m.id));
        li.innerHTML = `<span class="n" aria-hidden="true"></span><div class="body"><div class="what"></div><textarea rows="2" placeholder="What should change here?" maxlength="${MAX_NOTE}"></textarea></div><button class="rm" type="button">${X}</button>`;
      }
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
      const num = li.querySelector('.n');
      if (num && num.textContent !== n) num.textContent = n;
      const what = li.querySelector<HTMLElement>('.what');
      const whatText = m.what ?? '';
      if (what && what.textContent !== whatText) { what.textContent = whatText; what.title = whatText; }
      const ta = li.querySelector('textarea');
      if (ta) {
        if (ta.value !== m.note && this.root.activeElement !== ta) ta.value = m.note;
        ta.readOnly = locked;
        ta.setAttribute('aria-label', `Note ${n}`);
        if (locked) { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; }
      }
      li.querySelector('.rm')?.setAttribute('aria-label', `Remove note ${n}`);
    });
    if (this.fresh >= 0) { const id = this.fresh; this.fresh = -1; requestAnimationFrame(() => this.focusNote(id)); }
    // A shot that arrived after notes were pinned on it: name what they are on now.
    if (shotEl?.shot && marks.some((m) => !m.what)) {
      this.state = { ...this.state, marks: marks.map((m) => (m.what ? m : { ...m, what: this.describe(m) })) };
      this.remember(this.state);
      queueMicrotask(() => this.sync());
    }
    this.updateButton();
  }
}

class CanopyReview extends CanopyMarkup {
  constructor() { super(); this.review = true; }
}

define('canopy-markup', CanopyMarkup);
define('canopy-review', CanopyReview);
