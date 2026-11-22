// <canopy-scale width="1280" height="720">: content laid out at its true size (a slide, a window, a phone) and shrunk
// to the element's width. The room is the right shape from the first frame (aspect-ratio), so nothing jumps while
// it measures; the content stays hidden until it knows its scale, then appears at once. While it is still being
// written (data-writing, set by the page as the HTML streams in) it shimmers instead.
import { CanopyElement, define } from '../element';

const CSS = `
:host { display: block; position: relative; overflow: hidden; min-width: 0; }
.inner { position: absolute; top: 0; left: 0; transform-origin: 0 0; visibility: hidden; opacity: 1; transition: opacity 220ms ease-out; }
.inner[data-fit] { visibility: visible; }
/* Still being written: its room shimmers, and the design appears whole once it is (never half a slide). */
:host([data-writing]) { background: linear-gradient(100deg, var(--color-background-tertiary) 30%, color-mix(in oklch, var(--color-text-primary) 11%, var(--color-background-tertiary)) 50%, var(--color-background-tertiary) 70%) 0 0 / 300% 100%; animation: shimmer 1.6s linear infinite; }
:host([data-writing]) .inner { opacity: 0; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { :host([data-writing]) { animation: none; } .inner { transition: none; } }
`;

const size = (v: string | null, fallback: number) => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) && n >= 16 && n <= 10000 ? n : fallback;
};

class CanopyScale extends CanopyElement {
  private ro: ResizeObserver | null = null;
  private w = 1280;
  private h = 800;
  private drawn = '';
  constructor() { super(CSS); }

  connectedCallback() {
    super.connectedCallback();
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this);
  }
  disconnectedCallback() { super.disconnectedCallback(); this.ro?.disconnect(); this.ro = null; }

  protected render() {
    this.w = size(this.getAttribute('width'), 1280);
    this.h = size(this.getAttribute('height'), 800);
    // The shape lives in the shadow's own rule, under anything the widget's CSS says about this element.
    const html = `<style>:host { aspect-ratio: ${this.w} / ${this.h}; }</style><div class="inner" part="content" style="width:${this.w}px;height:${this.h}px"><slot></slot></div>`;
    if (this.drawn !== html) { this.drawn = html; this.root.innerHTML = html; }
    this.fit();
  }

  private fit() {
    const inner = this.root.querySelector<HTMLElement>('.inner');
    if (!inner) return;
    const width = this.clientWidth;
    if (!width) return;
    const t = `scale(${width / this.w})`;
    if (inner.style.transform !== t) inner.style.transform = t;
    inner.setAttribute('data-fit', '');
  }
}

define('canopy-scale', CanopyScale);
