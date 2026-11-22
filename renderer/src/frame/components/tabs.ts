// <canopy-tabs>: several views in one place, one <section label="..."> each, looking like the right panel's tabs.
// The open tab is remembered with the chat.
import { CanopyElement, define, esc, setAttr } from '../element';

const CSS = `
:host { display: block; }
.tabs { display: flex; gap: 20px; margin-bottom: 12px; border-bottom: 1px solid var(--color-border-tertiary); overflow-x: auto; scrollbar-width: none; }
/* No padding at the sides: the first tab's words start where the widget's own content starts. */
.tab { position: relative; flex: none; height: 30px; padding: 0; border: 0; border-radius: 0; font-weight: 400; color: var(--color-text-secondary); }
.tab:hover, .tab:active { background: transparent; color: var(--color-text-primary); transform: none; }
.tab[aria-selected="true"] { color: var(--color-text-primary); font-weight: 500; }
.tab[aria-selected="true"]::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 1.5px; background: var(--color-text-primary); }
.tab:focus-visible { outline-offset: -2px; }
::slotted(section) { display: none; }
::slotted(section[data-open]) { display: block; }
`;

class CanopyTabs extends CanopyElement {
  private open: number | null = null;
  constructor() { super(CSS); }
  private sections() { return Array.from(this.querySelectorAll<HTMLElement>(':scope > section')); }

  protected render() {
    const sections = this.sections();
    this.open ??= this.recall<number>() ?? 0;
    const at = Math.min(this.open, Math.max(0, sections.length - 1));
    sections.forEach((s, i) => { s.toggleAttribute('data-open', i === at); setAttr(s, 'role', 'tabpanel'); });
    const html = `<div class="tabs" role="tablist">${sections.map((s, i) => `<button class="tab" type="button" role="tab" aria-selected="${i === at}" data-i="${i}">${esc(s.getAttribute('label') || s.getAttribute('title') || `Tab ${i + 1}`)}</button>`).join('')}</div><slot></slot>`;
    if (this.root.innerHTML === html) return;
    this.root.innerHTML = html;
    this.root.querySelector('.tabs')?.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('.tab');
      if (!b) return;
      this.open = Number(b.getAttribute('data-i'));
      this.remember(this.open);
      this.changed();
    });
  }
}

define('canopy-tabs', CanopyTabs);
