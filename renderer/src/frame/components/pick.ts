// <canopy-pick>: pick on anything. The options are whatever the widget drew (a slide, a brand board, a chip), marked
// with option="Label"; the block adds what is the same every time: what is picked and what is pointed at, the
// keyboard, the preview that follows, a caption under each option when asked, and the confirm row that sends the pick
// and locks. Everything is in the light DOM the widget wrote, so its own CSS styles all of it; the block only sets
// state attributes (aria-checked, data-picked, data-shown) that the CSS can read.
//
// <canopy-pick> attributes: question, multiple, message="Go with {choice}", button="Use {choice}", captions ("off").
// option attributes: option (the label), value (sent instead of the label), hint, recommended.
// <canopy-preview>: children with for="Label" stacked in one cell; only the one shown is visible.
import { CanopyElement, define, esc, setAttr } from '../element';
import { rt } from '../runtime';
import { shownOption, togglePick } from '../marks';
import { fillPick, pickButton } from '../words';
import { CONFIRM_CSS, confirmRow, updateConfirm } from './confirm';

// ---- the caption the block writes under an option: its mark, label, the recommended dot, the hint ----

const CAPTION_CSS = `
:host { display: flex; align-items: flex-start; gap: 10px; padding: 8px 4px 2px; min-width: 0; text-align: left; }
.mark { flex: none; display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid color-mix(in oklch, var(--color-text-primary) 30%, transparent); border-radius: 50%; transition: background-color 120ms, border-color 120ms; }
:host([multiple]) .mark { border-radius: 4px; }
:host([checked]) .mark { border-color: var(--color-text-primary); background: var(--color-text-primary); }
:host([checked]) .mark::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--color-background-primary); }
:host([multiple][checked]) .mark::after { width: 10px; height: 10px; border-radius: 0; mask: var(--check) center / 10px no-repeat; }
.body { display: flex; flex-direction: column; min-width: 0; }
.label { display: flex; align-items: center; gap: 6px; color: var(--color-text-primary); }
.hint { display: -webkit-box; overflow: hidden; font-size: 12px; line-height: 16px; letter-spacing: 0; color: var(--color-text-secondary); -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
`;

class CanopyCaption extends CanopyElement {
  private drawn = '';
  constructor() { super(CAPTION_CSS); }
  protected render() {
    const hint = this.getAttribute('hint') ?? '';
    const html = `<span class="mark" aria-hidden="true"></span><span class="body"><span class="label">${esc(this.getAttribute('label'))}${this.hasAttribute('recommended') ? '<span class="dot" title="Recommended"></span>' : ''}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</span>`;
    if (this.drawn !== html) { this.drawn = html; this.root.innerHTML = html; }
  }
}

// ---- the preview: no behavior of its own, the pick tells its children which one is shown ----

class CanopyPreview extends HTMLElement {}

// ---- the pick ----

const CSS = `
:host { display: block; min-width: 0; }
.q { margin-bottom: 10px; font-weight: 500; }
.q small { font-weight: 400; }
${CONFIRM_CSS}
`;

type State = { picked?: string[]; sent?: boolean };
const label = (el: Element) => (el.getAttribute('option') ?? '').trim();
const OWNED = 'data-canopy'; // marks what the block itself put in the widget's DOM

class CanopyPick extends CanopyElement {
  private state: State | null = null;
  private hovered: string | null = null;
  private focused: string | null = null;
  private sending = false;
  private drawn = '';
  constructor() { super(CSS); }

  /** The options that belong to this pick (not to one nested inside it), in document order. */
  private options(): HTMLElement[] {
    return Array.from(this.querySelectorAll<HTMLElement>('[option]')).filter((el) => el.closest('canopy-pick') === this && label(el));
  }
  private optionOf(t: EventTarget | null): HTMLElement | null {
    const o = t instanceof Element ? t.closest<HTMLElement>('[option]') : null;
    return o && o.closest('canopy-pick') === this && label(o) ? o : null;
  }
  private get multiple() { return this.hasAttribute('multiple'); }
  private get locked() { return !!this.state?.sent; }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', (e) => {
      const o = this.optionOf(e.target);
      if (o) this.pick(o);
    });
    this.addEventListener('pointerover', (e) => {
      const next = this.optionOf(e.target);
      const name = next ? label(next) : null;
      if (name !== this.hovered) { this.hovered = name; this.update(); }
    });
    this.addEventListener('pointerleave', () => { if (this.hovered) { this.hovered = null; this.update(); } });
    this.addEventListener('focusin', (e) => {
      const o = this.optionOf(e.target);
      this.focused = o ? label(o) : null;
      this.update();
    });
    this.addEventListener('focusout', (e) => {
      if (!this.optionOf(e.relatedTarget)) { this.focused = null; this.update(); }
    });
    this.addEventListener('keydown', (e) => {
      const o = this.optionOf(e.target);
      if (!o || (e.target !== o && (e.target as Element).closest('input, textarea, select, [contenteditable]'))) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.pick(o); return; }
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0;
      if (!step) return;
      e.preventDefault();
      const all = this.options();
      const i = all.indexOf(o);
      const next = step === -Infinity ? all[0] : step === Infinity ? all[all.length - 1] : all[(i + step + all.length) % all.length];
      next?.focus({ preventScroll: false });
    });
  }

  private pick(o: HTMLElement) {
    if (this.locked || rt.streaming) return;
    const st = this.state ?? {};
    this.state = { ...st, picked: togglePick(this.pickedNow(), label(o), this.multiple) };
    this.remember(this.state);
    this.update();
  }

  /**
   * What is picked now. Until the user has clicked, a pick of several starts with the recommended ones ticked: the
   * model's suggestion, there to be changed. A pick of one starts empty; the recommended one only has the dot.
   */
  private pickedNow(all = this.options()): string[] {
    if (this.state?.picked) return this.state.picked;
    return this.multiple ? all.filter((o) => o.hasAttribute('recommended')).map(label) : [];
  }

  /** The words for what is picked, in the order of the options (not the order they were clicked). */
  private picks(all = this.options()) {
    const picked = this.pickedNow(all);
    return all.filter((o) => picked.includes(label(o)));
  }

  private async confirm() {
    const chosen = this.picks();
    if (!chosen.length || this.locked || this.sending || rt.streaming) return;
    const text = fillPick(this.getAttribute('message'), chosen.map((o) => o.getAttribute('value') || label(o)));
    this.sending = true;
    const ok = await rt.send(text);
    this.sending = false;
    if (!ok) return;
    this.state = { ...(this.state ?? {}), sent: true };
    this.remember(this.state);
    this.update();
  }

  protected render() {
    this.state ??= this.recall<State>() ?? {};
    const q = this.getAttribute('question') ?? '';
    const html = `${q ? `<div class="q">${esc(q)}${this.multiple ? ' <small class="muted">Pick any.</small>' : ''}</div>` : ''}<slot></slot>${confirmRow()}`;
    if (this.drawn !== html) {
      this.drawn = html;
      this.root.innerHTML = html;
      this.root.querySelector('button.send')?.addEventListener('click', () => { void this.confirm(); });
    }
    this.update();
  }

  /** Put the state on the options, the previews, the captions and the button. Only what differs is touched. */
  private update() {
    const all = this.options();
    const names = all.map(label);
    const picked = this.pickedNow(all).filter((n) => names.includes(n));
    const multiple = this.multiple;
    const locked = this.locked;
    const rec = all.find((o) => o.hasAttribute('recommended'));
    const shown = locked
      ? shownOption(names, { picked })
      : shownOption(names, { hovered: this.hovered, focused: this.focused, picked, recommended: rec ? label(rec) : null });
    // One stop for Tab: the option in focus, else the one picked last, else the first. Arrows move between them.
    const stop = this.focused && names.includes(this.focused) ? this.focused : picked.at(-1) ?? names[0];
    const captions = (this.getAttribute('captions') ?? '').toLowerCase();
    const always = captions !== '' && captions !== 'off' && captions !== 'false' && captions !== 'none';
    const never = captions === 'off' || captions === 'false' || captions === 'none';

    setAttr(this, 'role', multiple ? 'group' : 'radiogroup');
    if (this.getAttribute('question')) setAttr(this, 'aria-label', this.getAttribute('question') as string);
    this.toggleAttribute('data-locked', locked);
    if (shown) setAttr(this, 'data-shown', shown); else this.removeAttribute('data-shown');

    for (const o of all) {
      const name = label(o);
      const on = picked.includes(name);
      setAttr(o, 'role', multiple ? 'checkbox' : 'radio');
      setAttr(o, 'aria-checked', String(on));
      setAttr(o, 'tabindex', name === stop ? '0' : '-1');
      o.toggleAttribute('data-picked', on);
      o.toggleAttribute('data-shown', name === shown);
      if (locked) setAttr(o, 'aria-disabled', 'true'); else o.removeAttribute('aria-disabled');
      if (!o.hasAttribute('aria-label') && !o.hasAttribute('aria-labelledby')) setAttr(o, 'aria-label', name);
      // A caption, when the option has a hint to show or the pick asks for them.
      const want = !never && (always || o.hasAttribute('hint'));
      let cap = Array.from(o.children).find((c) => c.localName === 'canopy-caption' && c.hasAttribute(OWNED)) ?? null;
      if (!want && cap) { cap.remove(); cap = null; }
      if (want) {
        // Written before it goes in, so it draws whole the moment it is there. While the widget streams, the page's
        // morph takes it out with each piece that arrives; it is back before the next frame is painted.
        const c = cap ?? document.createElement('canopy-caption');
        if (!cap) { c.setAttribute(OWNED, ''); c.setAttribute('aria-hidden', 'true'); }
        setAttr(c, 'label', name);
        if (o.getAttribute('hint')) setAttr(c, 'hint', o.getAttribute('hint') as string); else c.removeAttribute('hint');
        c.toggleAttribute('recommended', o.hasAttribute('recommended'));
        c.toggleAttribute('multiple', multiple);
        c.toggleAttribute('checked', on);
        if (c !== o.lastElementChild) o.append(c); // new, or more of the option arrived after it: keep it last
      }
    }

    for (const p of Array.from(this.querySelectorAll('canopy-preview'))) {
      if (p.closest('canopy-pick') !== this) continue;
      for (const c of Array.from(p.children)) {
        if (!c.hasAttribute('for')) continue;
        const it = (c.getAttribute('for') ?? '').trim() === shown;
        c.toggleAttribute('data-shown', it);
        if (it) c.removeAttribute('aria-hidden'); else setAttr(c, 'aria-hidden', 'true');
      }
    }

    const words = this.picks(all).map(label);
    updateConfirm(this.root, pickButton(this.getAttribute('button'), words, multiple), words.length > 0 && !rt.streaming && !locked);
  }
}

define('canopy-caption', CanopyCaption);
define('canopy-preview', CanopyPreview);
define('canopy-pick', CanopyPick);
