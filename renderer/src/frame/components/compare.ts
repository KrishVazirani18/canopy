// <canopy-compare>: before and after in the same place, a divider to drag across. The first child is before (left
// of the divider), the second after; a `label` on each is shown above its side. Inside a pick the after side can be a
// <canopy-preview>, so what is compared is the option shown, and its label is that option's.
// The divider moves with the pointer anywhere on the stage, or with the arrow keys once focused.
import { CanopyElement, define, esc, setAttr } from '../element';

const CSS = `
:host { display: block; min-width: 0; }
.labels { display: flex; justify-content: space-between; gap: 12px; height: 16px; margin: 0 4px 6px; font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-secondary); }
.labels span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stage { position: relative; display: grid; overflow: hidden; border: 1px solid var(--color-border-tertiary); border-radius: var(--border-radius-lg); cursor: ew-resize; touch-action: none; user-select: none; -webkit-user-select: none; }
::slotted(*) { grid-area: 1 / 1; min-width: 0; }
::slotted([data-before]) { z-index: 1; clip-path: inset(0 calc(100% - var(--at, 50%)) 0 0); }
.divider { position: absolute; z-index: 2; top: 0; bottom: 0; left: var(--at, 50%); width: 0; outline: none; }
.divider::before { content: ""; position: absolute; top: 0; bottom: 0; left: -0.5px; width: 1px; background: color-mix(in oklch, var(--color-text-primary) 60%, transparent); }
.knob { position: absolute; top: 50%; left: 0; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1px solid var(--color-border-secondary); border-radius: 50%; background: var(--color-background-primary); color: var(--color-text-secondary); transform: translate(-50%, -50%); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.knob svg { width: 12px; height: 12px; }
.divider:focus-visible .knob { outline: 1.5px solid var(--color-ring-primary); outline-offset: 2px; }
:host(:not([data-pair])) .divider { display: none; }
:host(:not([data-pair])) .stage { cursor: default; }
`;

const ARROWS = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3L1.5 6 4 9M8 3l2.5 3L8 9"/></svg>';

/** Elements that are drawn: a <style> or <script> written among the children is not a side. */
const sides = (el: Element) => Array.from(el.children).filter((c) => !['style', 'script', 'template', 'link', 'meta'].includes(c.localName));

/** The words above a side: its own label, else (a preview) the label of what it shows. */
function sideLabel(el: Element | undefined): string {
  if (!el) return '';
  const own = el.getAttribute('label');
  if (own) return own;
  if (el.localName === 'canopy-preview') {
    const shown = Array.from(el.children).find((c) => c.hasAttribute('data-shown'));
    return shown?.getAttribute('label') || shown?.getAttribute('for') || '';
  }
  return '';
}

class CanopyCompare extends CanopyElement {
  private at: number | null = null;
  private drawn = '';
  constructor() { super(CSS); }

  protected render() {
    this.at ??= this.recall<number>() ?? 50;
    const [before, after] = sides(this);
    for (const c of sides(this)) {
      c.toggleAttribute('data-before', c === before && !!after);
      c.toggleAttribute('data-after', c === after);
    }
    this.toggleAttribute('data-pair', !!after);
    const a = sideLabel(before);
    const b = sideLabel(after);
    const html = `${a || b ? `<div class="labels" part="labels"><span>${esc(a)}</span><span>${esc(b)}</span></div>` : ''}<div class="stage" part="stage"><slot></slot><div class="divider" role="slider" tabindex="0" aria-label="${esc(a && b ? `${a} and ${b}: move the divider` : 'Move the divider')}" aria-valuemin="0" aria-valuemax="100"><span class="knob">${ARROWS}</span></div></div>`;
    if (this.drawn !== html) {
      this.drawn = html;
      this.root.innerHTML = html;
      this.wire();
    }
    this.place();
  }

  private place() {
    const stage = this.root.querySelector<HTMLElement>('.stage');
    const at = Math.max(0, Math.min(100, this.at ?? 50));
    stage?.style.setProperty('--at', `${at}%`);
    const d = this.root.querySelector('.divider');
    if (d) { setAttr(d, 'aria-valuenow', String(Math.round(at))); setAttr(d, 'aria-valuetext', `${Math.round(at)}%`); }
  }

  private move(at: number, keep = false) {
    this.at = Math.max(0, Math.min(100, Math.round(at * 10) / 10));
    this.place();
    if (keep) this.remember(this.at);
  }

  private wire() {
    const stage = this.root.querySelector<HTMLElement>('.stage');
    const divider = this.root.querySelector<HTMLElement>('.divider');
    if (!stage || !divider) return;
    const toX = (x: number) => { const r = stage.getBoundingClientRect(); return r.width ? ((x - r.left) / r.width) * 100 : 50; };
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.hasAttribute('data-pair')) return;
      // Something to press inside a side (a link, a control) keeps its own click.
      const inner = e.composedPath()[0];
      if (inner instanceof Element && inner.closest('a, button, input, select, textarea, [option]') && inner !== divider) return;
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      divider.focus({ preventScroll: true });
      this.move(toX(e.clientX));
      const mv = (ev: PointerEvent) => this.move(toX(ev.clientX));
      const up = () => { stage.removeEventListener('pointermove', mv); stage.removeEventListener('pointerup', up); stage.removeEventListener('pointercancel', up); this.move(this.at ?? 50, true); };
      stage.addEventListener('pointermove', mv);
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    });
    divider.addEventListener('keydown', (e) => {
      const by = e.shiftKey ? 10 : 2;
      const at = this.at ?? 50;
      const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? at - by : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? at + by : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : null;
      if (next === null) return;
      e.preventDefault();
      this.move(next, true);
    });
  }
}

define('canopy-compare', CanopyCompare);
