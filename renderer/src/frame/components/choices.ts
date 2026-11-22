// <canopy-choices> with <canopy-choice> children: options the user picks from, each with room for whatever helps
// them decide. Confirming sends the pick to Claude as the user's next message; after that the widget shows what was
// picked and locks, like an answered question card. Looks like Canopy's own question card (permission-card.tsx).
// <canopy-choices> attributes: question, multiple, layout="cards", message="Go with {choice}", button="Send".
// <canopy-choice> attributes: label, hint, value, recommended.
import { CanopyElement, define, esc, setAttr } from '../element';
import { rt } from '../runtime';

const CHOICE_CSS = `
:host { display: block; min-width: 0; }
.opt { display: flex; align-items: flex-start; gap: 12px; width: 100%; height: 100%; padding: 10px 14px; border: 1px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); text-align: left; transition: background-color 120ms, border-color 120ms, opacity 160ms; }
.opt:hover { border-color: color-mix(in oklch, var(--color-text-primary) 20%, transparent); background: color-mix(in oklch, var(--color-background-hover) 50%, transparent); }
:host([aria-checked="true"]) .opt { border-color: color-mix(in oklch, var(--color-text-primary) 40%, transparent); background: var(--color-background-hover); }
.mark { flex: none; display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid color-mix(in oklch, var(--color-text-primary) 30%, transparent); border-radius: 50%; transition: background-color 120ms, border-color 120ms; }
:host([data-multiple]) .mark { border-radius: 4px; }
:host([aria-checked="true"]) .mark { border-color: var(--color-text-primary); background: var(--color-text-primary); }
:host([aria-checked="true"]) .mark::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--color-background-primary); }
:host([data-multiple][aria-checked="true"]) .mark::after { width: 10px; height: 10px; border-radius: 0; mask: var(--check) center / 10px no-repeat; }
.body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.label { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 8px; }
.rec { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--color-text-tertiary); }
.label, .hint { overflow-wrap: anywhere; }
.hint { font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-secondary); }
.more { margin-top: 6px; color: var(--color-text-secondary); }
.more:not(.has) { display: none; }
:host([data-locked]) .opt { pointer-events: none; }
:host([data-locked]:not([aria-checked="true"])) .opt { opacity: 0.5; }
`;

class CanopyChoice extends CanopyElement {
  constructor() { super(CHOICE_CSS); }
  get label() { return this.getAttribute('label') || this.getAttribute('value') || ''; }
  get choice() { return this.getAttribute('value') || this.label; }

  connectedCallback() {
    super.connectedCallback();
  }

  protected render() {
    setAttr(this, 'role', this.hasAttribute('data-multiple') ? 'checkbox' : 'radio');
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    if (!this.hasAttribute('aria-checked')) this.setAttribute('aria-checked', 'false');
    const hint = this.getAttribute('hint') ?? '';
    // Anything inside the element is the option's own content, shown under its label.
    const has = Array.from(this.childNodes).some((n) => n.nodeType === 1 || (n.nodeValue ?? '').trim());
    const html = `<div class="opt" part="option"><span class="mark" aria-hidden="true"></span><span class="body">
      <span class="label"><span>${esc(this.label)}</span>${this.hasAttribute('recommended') ? '<span class="rec"><span class="dot"></span>Recommended</span>' : ''}</span>
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}<div class="more${has ? ' has' : ''}"><slot></slot></div></span></div>`;
    if (this.root.innerHTML !== html) this.root.innerHTML = html;
  }
}

const CSS = `
:host { display: block; }
.q { margin-bottom: 10px; font-weight: 500; }
.q small { font-weight: 400; }
.list { display: flex; flex-direction: column; gap: 6px; }
:host([layout="cards"]) .list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 8px; align-items: stretch; }
.foot { display: flex; justify-content: flex-end; margin-top: 12px; }
:host([data-locked]) .foot { display: none; }
`;

type State = { picked?: string[]; sent?: boolean };

class CanopyChoices extends CanopyElement {
  private state: State | null = null;
  private sending = false;
  constructor() { super(CSS); }

  private options() { return Array.from(this.querySelectorAll<CanopyChoice>(':scope > canopy-choice')); }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', (e) => { const o = (e.target as Element).closest?.('canopy-choice') as CanopyChoice | null; if (o && o.parentElement === this) this.pick(o); });
    this.addEventListener('keydown', (e) => {
      const o = e.target instanceof Element && e.target.localName === 'canopy-choice' ? e.target as CanopyChoice : null;
      if (!o || o.parentElement !== this) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.pick(o); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const all = this.options();
        const next = all[(all.indexOf(o) + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
        next?.focus();
      }
    });
  }

  private pick(o: CanopyChoice) {
    const st = this.state ?? {};
    if (st.sent || rt.streaming) return;
    const v = o.choice;
    const cur = st.picked ?? [];
    const picked = this.hasAttribute('multiple') ? (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]) : [v];
    this.state = { ...st, picked };
    this.remember(this.state);
    this.changed();
  }

  private async confirm() {
    const st = this.state ?? {};
    const picked = st.picked ?? [];
    if (!picked.length || st.sent || this.sending) return;
    const template = this.getAttribute('message') || '{choice}';
    const text = template.includes('{choice}') ? template.replaceAll('{choice}', picked.join(', ')) : `${template} ${picked.join(', ')}`;
    this.sending = true;
    const ok = await rt.send(text);
    this.sending = false;
    if (!ok) return;
    this.state = { ...st, sent: true };
    this.remember(this.state);
    this.changed();
  }

  protected render() {
    this.state ??= this.recall<State>() ?? {};
    const st = this.state;
    const multiple = this.hasAttribute('multiple');
    const picked = st.picked ?? [];
    setAttr(this, 'role', multiple ? 'group' : 'radiogroup');
    this.toggleAttribute('data-locked', !!st.sent);
    for (const o of this.options()) {
      o.toggleAttribute('data-multiple', multiple);
      o.toggleAttribute('data-locked', !!st.sent);
      setAttr(o, 'aria-checked', String(picked.includes(o.choice)));
    }
    const question = this.getAttribute('question') ?? '';
    const button = this.getAttribute('button') || 'Send';
    const html = `${question ? `<div class="q">${esc(question)}${multiple ? ' <small>Pick any.</small>' : ''}</div>` : ''}
      <div class="list"><slot></slot></div>
      <div class="foot"><button class="primary" type="button"${picked.length && !rt.streaming ? '' : ' disabled'}>${esc(button)}</button></div>`;
    if (this.root.innerHTML === html) return;
    this.root.innerHTML = html;
    this.root.querySelector('button')?.addEventListener('click', () => { void this.confirm(); });
  }
}

define('canopy-choice', CanopyChoice);
define('canopy-choices', CanopyChoices);
