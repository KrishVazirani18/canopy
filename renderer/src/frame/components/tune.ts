// <canopy-tune>: dial a design in and send the values. Every input and select with a `name` inside sets a CSS custom
// property --<name> on the block (numbers and ranges as value+unit, a checkbox as 1/0, colors and selects as they are),
// so the preview the widget drew follows with `var(--name)` and no script. Each control's label carries its value in
// data-value, which the default look shows beside a slider. The confirm row sends "Corner radius 18px, Shadow on".
// Attributes: message="Set the cards to {values}", button="Use these values".
import { CanopyElement, define, setAttr } from '../element';
import { rt } from '../runtime';
import { cssValue, fillTune, shownValue, type TuneControl } from '../words';
import { CONFIRM_CSS, confirmRow, updateConfirm } from './confirm';

const STYLE = `
:host { display: block; min-width: 0; }
${CONFIRM_CSS}
.reset { height: 28px; padding: 0 8px; border: 0; color: var(--color-text-secondary); font-weight: 400; }
.reset:hover { color: var(--color-text-primary); }
.reset[data-off] { visibility: hidden; }
:host([data-locked]) .reset { display: none; }
`;

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type State = { sent?: boolean };
const varName = (name: string) => `--${name.trim().replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** A label's own words, without the text of the controls inside it (a select's options) or what the block added. */
function labelWords(el: Element | null): string {
  if (!el) return '';
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('input, select, textarea, datalist, output, [data-canopy], script, style').forEach((x) => x.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

class CanopyTune extends CanopyElement {
  private state: State | null = null;
  private sending = false;
  private drawn = '';
  constructor() { super(STYLE); }

  private controls(): Control[] {
    return Array.from(this.querySelectorAll<Control>('input[name], select[name], textarea[name]'))
      .filter((c) => c.closest('canopy-tune') === this && !['button', 'submit', 'reset', 'file', 'hidden', 'image', 'password'].includes(c.type));
  }

  private labelOf(c: Control): Element | null {
    return c.closest('label') ?? (c.id ? this.querySelector(`label[for="${CSS.escape(c.id)}"]`) : null);
  }

  /** Each named value once (radios of one name are one value), as the words module wants them. */
  private read(): { c: Control; label: Element | null; v: TuneControl }[] {
    const out: { c: Control; label: Element | null; v: TuneControl }[] = [];
    const radios = new Set<string>();
    for (const c of this.controls()) {
      const name = c.getAttribute('name') as string;
      if (c instanceof HTMLInputElement && c.type === 'radio') {
        if (radios.has(name)) continue;
        radios.add(name);
        const group = this.controls().filter((x): x is HTMLInputElement => x instanceof HTMLInputElement && x.type === 'radio' && x.name === name);
        const on = group.find((x) => x.checked);
        const set = c.closest('fieldset');
        const title = set?.querySelector('legend')?.textContent?.trim() || c.closest('[role="radiogroup"]')?.getAttribute('aria-label') || name;
        out.push({ c, label: null, v: { label: title, type: 'radio', value: on?.value ?? '', text: on ? labelWords(this.labelOf(on)) : '' } });
        continue;
      }
      const label = this.labelOf(c);
      const words = labelWords(label) || c.getAttribute('aria-label') || name;
      const type = c instanceof HTMLSelectElement ? 'select' : c.type;
      const text = c instanceof HTMLSelectElement ? c.selectedOptions[0]?.textContent ?? '' : '';
      out.push({ c, label, v: { label: words, type, value: c.value, unit: c.getAttribute('unit'), checked: c instanceof HTMLInputElement ? c.checked : false, text } });
    }
    return out;
  }

  /** Anything moved from where the widget set it. */
  private changedFromStart(): boolean {
    return this.controls().some((c) => {
      if (c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio')) return c.checked !== c.defaultChecked;
      if (c instanceof HTMLSelectElement) { const o = Array.from(c.options); return c.value !== ((o.find((x) => x.defaultSelected) ?? o[0])?.value ?? ''); }
      return c.value !== c.defaultValue;
    });
  }

  connectedCallback() {
    super.connectedCallback();
    const on = () => this.update();
    this.addEventListener('input', on);
    this.addEventListener('change', on);
  }

  private reset() {
    if (this.state?.sent) return;
    for (const c of this.controls()) {
      let moved = false;
      if (c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio')) { if (c.checked !== c.defaultChecked) { c.checked = c.defaultChecked; moved = true; } }
      else if (c instanceof HTMLSelectElement) { const o = Array.from(c.options); const want = (o.find((x) => x.defaultSelected) ?? o[0])?.value ?? ''; if (c.value !== want) { c.value = want; moved = true; } }
      else if (c.value !== c.defaultValue) { c.value = c.defaultValue; moved = true; }
      // Told the way a person's change would be: the frame remembers it, and the widget's own script hears it.
      if (moved) { c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    this.update();
  }

  private async confirm() {
    if (this.state?.sent || this.sending || rt.streaming) return;
    const text = fillTune(this.getAttribute('message'), this.read().map((r) => r.v));
    this.sending = true;
    const ok = await rt.send(text);
    this.sending = false;
    if (!ok) return;
    this.state = { sent: true };
    this.remember(this.state);
    this.update();
  }

  protected render() {
    this.state ??= this.recall<State>() ?? {};
    const html = `<style class="vars"></style><slot></slot>${confirmRow('<button class="reset aside" type="button" data-off>Reset</button>')}`;
    if (this.drawn !== html) {
      this.drawn = html;
      this.root.innerHTML = html;
      this.root.querySelector('button.send')?.addEventListener('click', () => { void this.confirm(); });
      this.root.querySelector('button.reset')?.addEventListener('click', () => this.reset());
    }
    this.update();
  }

  private update() {
    const locked = !!this.state?.sent;
    const rows = this.read();
    // The values as the block's own variables. `!important` from inside the shadow outranks what the widget's CSS
    // (even an inline style) says about this element, so a default written there cannot freeze the preview.
    const vars = rows.map((r) => `${varName(r.c.getAttribute('name') as string)}: ${cssValue(r.v).replace(/[;{}<]/g, '')} !important;`).join(' ');
    const sheet = this.root.querySelector('style.vars');
    const rule = `:host { ${vars} }`;
    if (sheet && sheet.textContent !== rule) sheet.textContent = rule;
    for (const r of rows) if (r.label) setAttr(r.label, 'data-value', shownValue(r.v));
    this.toggleAttribute('data-locked', locked);
    if (locked) for (const c of this.controls()) if (!c.disabled) c.disabled = true;
    const changed = this.changedFromStart();
    this.root.querySelector('button.reset')?.toggleAttribute('data-off', !changed);
    updateConfirm(this.root, this.getAttribute('button') || 'Use these values', changed && !rt.streaming && !locked);
  }
}

define('canopy-tune', CanopyTune);
