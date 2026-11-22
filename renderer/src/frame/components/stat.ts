// <canopy-stat label value delta tone>: one headline number, the way Canopy's Stats panel writes one. A quiet label,
// the value large, and an optional change beside it (tone="good" or "bad" adds the one small dot of color).
// Put a few in <div class="grid">. A script can set the attributes and it redraws.
import { CanopyElement, define, esc } from '../element';

const CSS = `
:host { display: block; min-width: 0; padding: 12px 14px; border: 1px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); }
.label { font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 8px; margin-top: 2px; }
.value { font-size: 22px; line-height: 28px; font-weight: 500; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.delta { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 16px; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.note { margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--color-text-tertiary); }
.note:not(.has) { display: none; }
`;

class CanopyStat extends CanopyElement {
  constructor() { super(CSS); }
  protected render() {
    const tone = this.getAttribute('tone');
    const delta = this.getAttribute('delta') ?? '';
    const has = Array.from(this.childNodes).some((n) => n.nodeType === 1 || (n.nodeValue ?? '').trim());
    const html = `<div class="label">${esc(this.getAttribute('label'))}</div>
      <div class="line"><span class="value">${esc(this.getAttribute('value')) || '&nbsp;'}</span>
      ${delta ? `<span class="delta">${tone === 'good' || tone === 'bad' || tone === 'warn' ? `<span class="dot ${tone}"></span>` : ''}${esc(delta)}</span>` : ''}</div>
      <div class="note${has ? ' has' : ''}"><slot></slot></div>`;
    if (this.root.innerHTML !== html) this.root.innerHTML = html;
  }
}

define('canopy-stat', CanopyStat);
