// <canopy-rank>: drag into order. Children with item="Label" (and an optional hint) are the things to order; each is
// drawn as a row with its place and a grip, and the item's own content, if it has any, is shown in the row (else its
// label and hint). Drag a row, or focus one and press Alt+Up/Down (arrows alone move between rows). The confirm row
// sends the order: "In this order:\n1. A\n2. B", or the `message` template with {order} in it.
// Attributes: message, button ("Use this order").
import { CanopyElement, define, esc, setAttr } from '../element';
import { rt } from '../runtime';
import { moveItem, reconcileOrder } from '../marks';
import { fillRank } from '../words';
import { CONFIRM_CSS, confirmRow, updateConfirm } from './confirm';

const CSS = `
:host { display: block; min-width: 0; }
.list { display: flex; flex-direction: column; gap: 6px; }
.row { position: relative; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); cursor: grab; outline: none; touch-action: none; user-select: none; -webkit-user-select: none; transition: background-color 120ms, border-color 120ms, box-shadow 120ms; }
.row:hover { border-color: color-mix(in oklch, var(--color-text-primary) 20%, transparent); }
.row:focus-visible { outline: 1.5px solid var(--color-ring-primary); outline-offset: 2px; }
.row[data-dragging] { z-index: 2; cursor: grabbing; border-color: color-mix(in oklch, var(--color-text-primary) 40%, transparent); background: var(--color-background-hover); box-shadow: 0 6px 18px -6px rgb(0 0 0 / 0.35); }
:host([data-locked]) .row { cursor: default; }
:host([data-locked]) .row:hover { border-color: var(--color-border-tertiary); }
.num { flex: none; width: 16px; text-align: center; font-size: 12px; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.grip { flex: none; width: 14px; height: 14px; color: var(--color-text-tertiary); }
:host([data-locked]) .grip { visibility: hidden; }
.body { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.label { color: var(--color-text-primary); overflow-wrap: anywhere; }
.hint { font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-secondary); }
::slotted(*) { min-width: 0; }
.live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
${CONFIRM_CSS}
`;

const GRIP = '<svg class="grip" viewBox="0 0 16 16" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></g></svg>';

type State = { order?: string[]; sent?: boolean };
const name = (el: Element) => (el.getAttribute('item') ?? '').trim();
/** An item that says more than its label: anything inside it. */
const hasContent = (el: Element) => Array.from(el.childNodes).some((n) => n.nodeType === 1 || (n.nodeValue ?? '').trim());

class CanopyRank extends CanopyElement {
  private state: State | null = null;
  private sending = false;
  private drawn = '';
  private sig = '';
  constructor() { super(CSS); }

  private items(): HTMLElement[] {
    return Array.from(this.querySelectorAll<HTMLElement>(':scope > [item]')).filter((el) => name(el));
  }
  private order(items = this.items()): string[] {
    return reconcileOrder(this.state?.order, Array.from(new Set(items.map(name))));
  }
  private get locked() { return !!this.state?.sent; }

  protected render() {
    this.state ??= this.recall<State>() ?? {};
    const items = this.items();
    const order = this.order(items);
    if (!this.drawn) {
      this.drawn = 'yes';
      this.root.innerHTML = `<div class="list" role="list"></div><div class="live" aria-live="polite"></div>${confirmRow()}`;
      this.wire();
    }
    const list = this.root.querySelector<HTMLElement>('.list');
    if (!list) return;
    setAttr(list, 'aria-label', this.getAttribute('aria-label') || 'Drag into order, or use Alt and the arrow keys');
    // Each item goes into a slot of its own, so the rows can be put in any order without moving what the widget wrote.
    items.forEach((el, i) => setAttr(el, 'slot', `i${i}`));
    const sig = JSON.stringify(items.map((el) => [name(el), el.getAttribute('hint') ?? '', hasContent(el)]));
    if (sig !== this.sig) {
      this.sig = sig;
      const focused = (this.root.activeElement as HTMLElement | null)?.getAttribute?.('data-name');
      list.innerHTML = items.map((el, i) => {
        const n = name(el);
        const hint = el.getAttribute('hint') ?? '';
        return `<div class="row" part="row" role="listitem" tabindex="0" data-name="${esc(n)}" aria-roledescription="Draggable item"><span class="num"></span>${GRIP}<div class="body">${hasContent(el) ? '' : `<span class="label">${esc(n)}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}`}<slot name="i${i}"></slot></div></div>`;
      }).join('');
      if (focused) this.row(focused)?.focus({ preventScroll: true });
    }
    // The rows in order. Moving a row takes its focus away, so the one in focus gets it back.
    const focused = this.root.activeElement as HTMLElement | null;
    order.forEach((n, at) => {
      const r = this.row(n);
      if (!r) return;
      if (list.children[at] !== r) list.insertBefore(r, list.children[at] ?? null);
      const num = r.querySelector('.num');
      if (num && num.textContent !== String(at + 1)) num.textContent = String(at + 1);
      setAttr(r, 'aria-label', `${at + 1}. ${n}`);
    });
    if (focused && this.root.activeElement !== focused && focused.isConnected) focused.focus({ preventScroll: true });
    this.toggleAttribute('data-locked', this.locked);
    updateConfirm(this.root, this.getAttribute('button') || 'Use this order', !this.locked && !rt.streaming && order.length > 1);
  }

  private row(n: string) {
    return Array.from(this.root.querySelectorAll<HTMLElement>('.row')).find((r) => r.getAttribute('data-name') === n) ?? null;
  }

  private setOrder(order: string[], say?: string) {
    this.state = { ...this.state, order };
    this.remember(this.state);
    this.render();
    if (say) { const live = this.root.querySelector('.live'); if (live) live.textContent = say; }
  }

  /** The rows slide to their new places instead of jumping there. */
  private flip(apply: () => void, except?: string) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = new Map(Array.from(this.root.querySelectorAll<HTMLElement>('.row')).map((r) => [r.getAttribute('data-name'), r.getBoundingClientRect().top]));
    apply();
    if (still) return;
    for (const r of Array.from(this.root.querySelectorAll<HTMLElement>('.row'))) {
      const n = r.getAttribute('data-name');
      if (n === except) continue;
      const was = before.get(n);
      const dy = was === undefined ? 0 : was - r.getBoundingClientRect().top;
      if (dy) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
  }

  private wire() {
    this.root.querySelector('button.send')?.addEventListener('click', () => { void this.confirm(); });
    const list = this.root.querySelector<HTMLElement>('.list');
    if (!list) return;

    list.addEventListener('keydown', (e) => {
      const r = (e.target as Element).closest?.('.row') as HTMLElement | null;
      if (!r || this.locked) return;
      const n = r.getAttribute('data-name') as string;
      const order = this.order();
      const i = order.indexOf(n);
      const up = e.key === 'ArrowUp';
      const down = e.key === 'ArrowDown';
      if (!up && !down) return;
      e.preventDefault();
      if (e.altKey) {
        if (rt.streaming) return;
        const to = i + (up ? -1 : 1);
        if (to < 0 || to >= order.length) return;
        this.flip(() => this.setOrder(moveItem(order, i, to), `${n}, now ${to + 1} of ${order.length}`));
        this.row(n)?.focus({ preventScroll: true });
      } else {
        this.row(order[i + (up ? -1 : 1)] ?? '')?.focus();
      }
    });

    list.addEventListener('pointerdown', (e) => {
      const r = (e.composedPath()[0] as Element | undefined)?.closest?.('.row') as HTMLElement | null;
      if (!r || e.button !== 0 || this.locked || rt.streaming) return;
      // Something to press inside an item keeps its own click.
      const inner = e.composedPath()[0];
      if (inner instanceof Element && inner.closest('a, button, input, select, textarea')) return;
      e.preventDefault();
      r.focus({ preventScroll: true });
      const n = r.getAttribute('data-name') as string;
      list.setPointerCapture(e.pointerId);
      const current = () => this.row(n);
      let shift = 0; // how far the row is drawn from where it is laid out
      const laidTop = () => (current()?.getBoundingClientRect().top ?? 0) - shift;
      const offset = e.clientY - laidTop();
      current()?.setAttribute('data-dragging', '');
      const mv = (ev: PointerEvent) => {
        const me = current();
        if (!me) return;
        // Where the row would be under the pointer, kept inside the list.
        const box = list.getBoundingClientRect();
        const top = Math.max(box.top, Math.min(box.bottom - me.offsetHeight, ev.clientY - offset));
        const order = this.order();
        const i = order.indexOf(n);
        // Past the middle of a neighbour: trade places with it.
        const above = this.row(order[i - 1] ?? '')?.getBoundingClientRect();
        const below = this.row(order[i + 1] ?? '')?.getBoundingClientRect();
        let to = i;
        if (above && top < above.top + above.height / 2) to = i - 1;
        else if (below && top + me.offsetHeight > below.top + below.height / 2) to = i + 1;
        if (to !== i) {
          this.flip(() => this.setOrder(moveItem(order, i, to)), n);
          current()?.setAttribute('data-dragging', '');
        }
        const now = current();
        if (!now) return;
        shift = top - laidTop();
        now.style.transform = `translateY(${shift}px)`;
      };
      const up = () => {
        list.removeEventListener('pointermove', mv);
        list.removeEventListener('pointerup', up);
        list.removeEventListener('pointercancel', up);
        const now = current();
        if (now) {
          const dy = shift;
          now.style.transform = '';
          now.removeAttribute('data-dragging');
          if (dy && !matchMedia('(prefers-reduced-motion: reduce)').matches) now.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 140, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
          now.focus({ preventScroll: true });
        }
        const order = this.order();
        const live = this.root.querySelector('.live');
        if (live) live.textContent = `${n}, now ${order.indexOf(n) + 1} of ${order.length}`;
      };
      list.addEventListener('pointermove', mv);
      list.addEventListener('pointerup', up);
      list.addEventListener('pointercancel', up);
    });
  }

  private async confirm() {
    if (this.locked || this.sending || rt.streaming) return;
    const items = this.items();
    const byName = new Map(items.map((el) => [name(el), el]));
    const order = this.order(items).map((n) => byName.get(n)?.getAttribute('value') || n);
    if (!order.length) return;
    this.sending = true;
    const ok = await rt.send(fillRank(this.getAttribute('message'), order));
    this.sending = false;
    if (!ok) return;
    this.state = { ...this.state, order: this.order(items), sent: true };
    this.remember(this.state);
    this.render();
  }
}

define('canopy-rank', CanopyRank);
