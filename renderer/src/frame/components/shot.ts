// <canopy-shot ref="look-3" alt="…">: a screenshot the `look` tool took in this chat. The model cannot write pixels into
// HTML, so it names the shot and the host hands the picture over (canopy/shot). While it comes, a quiet block of the
// shape it will have (remembered from last time, else a window's 16:10) holds its place; if the host has none, one
// line says so. A markup around it reads the picture and its element map from here.
import { CanopyElement, define, esc } from '../element';
import { shot, type Shot } from '../runtime';

const CSS = `
:host { display: block; min-width: 0; }
.ph, img { display: block; width: 100%; border-radius: var(--border-radius-lg); }
.ph { background: var(--color-background-tertiary); }
img { height: auto; border: 1px solid var(--color-border-tertiary); background: var(--color-background-tertiary); }
.none { display: flex; align-items: center; gap: 8px; height: 24px; font-size: 12px; line-height: 16px; color: var(--color-text-tertiary); }
.none::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: color-mix(in oklch, var(--color-text-tertiary) 60%, transparent); }
`;

export type ShotElement = HTMLElement & { readonly shot: Shot | null; readonly ready: Promise<Shot | null> };

class CanopyShot extends CanopyElement {
  private ref = '';
  private data: Shot | null = null;
  private failed = false;
  private drawn = '';
  private waiting: Promise<Shot | null> = Promise.resolve(null);
  constructor() { super(CSS); }

  /** The picture and its element map once the host has handed them over, else null. */
  get shot() { return this.data; }
  /** Settles once the host has answered (null when it had nothing). */
  get ready() { return this.waiting; }

  // Remembered by the shot it shows, so two widgets showing one shot agree, and one inside a review is found too.
  protected get key() { return `shot:${this.ref}`; }

  protected render() {
    const ref = (this.getAttribute('ref') ?? '').trim();
    if (ref && ref !== this.ref) {
      this.ref = ref;
      this.data = null;
      this.failed = false;
      const asked = shot(ref);
      this.waiting = asked;
      asked.then((s) => {
        if (this.ref !== ref) return;
        this.data = s;
        this.failed = !s;
        if (s) this.remember([s.width, s.height]);
        this.changed();
        this.dispatchEvent(new CustomEvent('canopy-shot', { bubbles: true, composed: true }));
      });
    }
    const alt = this.getAttribute('alt') || (this.data?.url ? `Screenshot of ${this.data.url}` : 'Screenshot');
    const size = this.data ? [this.data.width, this.data.height] : this.recall<number[]>() ?? [16, 10];
    const html = this.failed ? '<div class="none" part="none">Screenshot not available</div>'
      : this.data ? `<img part="image" src="${esc(this.data.data)}" alt="${esc(alt)}" draggable="false" style="aspect-ratio:${size[0]} / ${size[1]}">`
        : `<div class="ph" part="placeholder" role="img" aria-label="${esc(alt)}, loading" style="aspect-ratio:${size[0]} / ${size[1]}"></div>`;
    if (this.drawn !== html) { this.drawn = html; this.root.innerHTML = html; }
  }
}

define('canopy-shot', CanopyShot);
